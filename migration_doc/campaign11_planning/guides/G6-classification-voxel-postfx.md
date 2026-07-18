# G6 — Classification + Voxel Parity (cluster 13) & Post-process + Effects (cluster 16) — Campaign-11 Execution Guide

**Written 2026-07-18 against HEAD `5b98ab9698` (Batch 699, `C10-02-TILES-STYLE-COMMAND-ECONOMICS`, `main`).**
C10 workers are landing daily (B693–699 landed while the register was being written) — **re-verify every
anchor by symbol grep before editing; symbols are the contract, line numbers are hints.** All anchors
below were verified live at Batch-699 HEAD; the key anchor files
(`WebGPUVoxelRenderer.ts`, `WebGPUGroundPrimitiveRenderer.js`, `WebGPUContext.ts`, `Scene.js`,
`WebGPUSceneRendererEnsureResources.ts`, `WebGPUAutoExposure.ts`, `WebGPUTranslucentTileClassification.ts`)
were **clean in `git status` at verification time**, so working-tree greps == HEAD for them. If a file
shows dirty when you start, run `git show HEAD:<path> | grep ...` and attribute the dirt to a C10 task
before touching anything.

**Register rows covered (referred to ONLY by register/source names — the orchestrator assigns campaign
numbers at assembly):**

| Cluster | Items (priority as scheduled here) |
| --- | --- |
| classification-voxel | **NEW-VOXEL-INSIDE-CAMERA-BLACK (P0, per cluster direction)** · PARITY-VOXEL-OCTREE-TRAVERSAL (P1) · NEW-CLASSIFIER-2D-CV-MORPH (P1) · NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION (P1) · C-R9-VOXEL-CELL-PICK-TAIL (P1 — **PREMISE-STALE, see item**) · C-R1-CLASSIFICATION (P1) · NEW-GS-CLASSIFICATION-DEPTH (P2) · C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES (P2) · ADR-2026-04-28 / C-R8-TRANSLUCENT-MULTI-FRUSTUM (P2) · VOXEL-USER-CUSTOMSHADER-RESIDUALS (P2) |
| postprocess-effects | C9-23-EFFECT-EXECUTION-AUDIT / FAR-500-C0 (P1) · **sunBloom-inert-on-WebGPU (matrix row 3, folded in per direction)** · AutoExposure-always-on-SDR (matrix row 14, folded in) · usePostProcessSelected-hardwired-false (matrix row 19, folded in) · WIRE-PP-LIBRARY-BUILTINS-RESIDUALS (P2) · NEW-PLAIN-HDR-SCENE-GAMMA-EPIC residual (P2) · C6-SSGI-DIFFUSE follow-ups (P2) · NEW-PP-F16-DEVICE-VERIFY (P2, env-gated) · WGF-1-EXPAND (P2) · WGF-1-INTERSECTION (P2) · WGF-4 + WGF-4-EXPAND (P3 dossier) · C6-FSR2-UPSCALE (P3 gated-epic dossier) |

**Charter (binding, never weakened by anything below):** no feature removal/default-disable/visual
degradation for a metric; rule-3 conservatism (unknown demand keeps the conservative path); probe-first
visual verification (CLAUDE.md Principle 8 — read the PNGs yourself); premise-verify-first (several
register rows in THIS cluster are provably stale); one concern per slice; moving-altitude route is the
only valid perf evidence; promotion bar ≥10% whole-route / ≥15% near-ground WebGPU CPU-p95 or >3×
measured noise; land as kurtyoung-dev; ledger row updated in the same commit.

**Landed Batches 683–699 interaction map (read before ANY slice in either cluster):**

| Landed work | What changed | Who in this guide must care |
| --- | --- | --- |
| B693 `C10-01` env-command frustum binning | Default 3D = **ONE frustum** on WebGPU (was a permanent 2-frustum floor); sentinel `probe-frustum-count-3d.mjs` | Every classification item (per-slice `fstate` UBO ring now sees ONE slice at defaults; any doc text saying "slice 0 = far [1e8,1e10]" is pre-B693 history); ADR multi-frustum accumulation (default frames no longer exercise multi-frustum at all) |
| B697 `C10-03` demand-driven scene-color resolve | Scene-COLOR resolves 9→1/frame, resolve-on-consume; kill switch `_sceneColorResolveElisionEnabled` | Any composite/PP pass that READS scene color must be a registered consumer; the open `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING` latent bug is the canonical failure shape — un-pausing the ADR translucent-classification composite must not repeat it |
| B699 `C10-02` translucent-twin gate | Phantom translucent twin commands gated on `styleCommandsNeeded` — unstyled tile command count HALVED | GS-classification + any probe counting translucent tile commands; C-R1-CLASSIFICATION renderState routing (twin population changed) |
| B695 `C10-10` shadow single-sweep | Caster collection folded into the single PVS walk | None of these items directly; don't "re-collect" casters in any classification pass |
| B694 `C10-09` prev-buffer revision-skip | Velocity prev-instance re-uploads revision-skipped in 3 renderers | Voxel velocity leg (inside-camera acceptance preserves velocity/depth); TAA-adjacent PP work |
| B687/B688 `C9-17` A/B | Model group-1 bind-group caching + loader-owned geometry revision tokens | Model-adjacent classification (invert classification, b3dm); don't add per-frame bind-group churn in new effect wiring |
| B698 `C10-05` model mip chain | Model material sampling unlocked from mip 0 | **Baseline refresh hazard**: any stored PNG captured pre-B698 with models/tiles in frame diffs for innocent reasons — recapture baselines at HEAD before attributing |
| B696 `C10-04` BLOCK verdict | `NEW-WEBGPU-SPLAT-DATA-PRODUCER` filed — WebGPU splats have NO production data producer | **NEW-GS-CLASSIFICATION-DEPTH is downstream of it** (see item) |

---

## PART A — classification-voxel cluster

### A1. NEW-VOXEL-INSIDE-CAMERA-BLACK — **P0 (cluster anchor)**

**WHAT + WHY.** Camera INSIDE the voxel proxy volume (0.55R–0.9R on the diagonal of an Earth-radius
box) renders **BLACK on WebGPU while WebGL renders the volume interior** at every tested depth; just
outside (1.05R) both render. Found 2026-07-03 while designing the LRU-evict probe
(`DEFERRED_WORK.md:3456`, entry `NEW-VOXEL-INSIDE-CAMERA-BLACK`); carried as C8 queue #8 and C9 queue
§5 W1-18 (`QUEUE_2026-07-15_CAMPAIGN9.md:209`, risk R3): *"Correct proxy-face/cull/ray interval
through outside/boundary/inside/center/exit while preserving color, object/cell pick, velocity/depth,
octree, megatexture, and custom shaders."* Also `FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md:276`
(P1 there, promoted to P0 by C11 cluster direction): *"Repair ray/volume entry handling; **do not
disable inside views**."* No fix in git — verified: no batch since B526 touches an inside-camera path
(`git log --oneline -S "inside" -- packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` at
your session start to re-confirm).

**ARCHITECTURE TODAY (verified at `5b98ab9698`).**

- All four voxel render pipelines rasterize the proxy cube with
  `primitive: { topology: "triangle-list", cullMode: "front" }` —
  `WebGPUVoxelRenderer.ts:2643` (color), `:2676`, `:2707`, `:2732` (pick/cell-pick/velocity family).
  Cull-front (draw back faces) is the standard camera-may-be-inside trick, but it FAILS when the
  camera is inside AND the **back faces are beyond the far plane or the near plane clips them** —
  or when a scene-level cull rejects the command.
- The march itself already handles an interior ray origin:
  `let tStart = max(trReal.x, 0.0)` at `WebGPUVoxelRenderer.ts:815` (color march, plus dithered
  variant) and `:1114` (pick march); `intersectAABB` at `:365` with call sites `:478/:763/:1012`.
  The DEFERRED_WORK entry's suspect list stands verified: **NOT the march** — suspects are (a)
  proxy-cube rasterization vs the camera-inside near-plane/RTE vertex path, (b) scene-level culling
  of the WebGPU draw command (BV test vs a camera inside the BV), (c) depth-test of back faces
  against globe/depth at interior distances.
- Repro harness ingredient verified: `Tools/visual-regression/probe-voxel-megatexture.mjs` PART 3
  (`:437` onward) has `window.__evictProbe.setCorner(sign)` (`:485`) — but note its own comment at
  `:479`: PART 3 deliberately keeps *"the camera OUTSIDE the volume (camera-inside proxy…"* —
  i.e. the existing probe **avoids** this bug. The repro is a NEW probe built from that harness with
  `setCorner` destinations scaled to 0.55R, not a rerun of PART 3.

**IMPLEMENTATION WALKTHROUGH.**

1. **Probe FIRST** (Principle 8). Author `Tools/visual-regression/probe-voxel-inside-camera.mjs`,
   cloned from the PART-3 harness of `probe-voxel-megatexture.mjs` (same voxel-octree-l3 box
   provider). Waypoint ladder along the box diagonal: 1.05R (outside — both render, control),
   1.0R (boundary), 0.9R, 0.55R (deep interior), ~0.05R (near center), then exit through the
   opposite face. At each waypoint capture WebGL + WebGPU PNGs, count non-black voxel-colored
   pixels, log `scene.numberOfFrustums`, device errors, and — diagnostic gold —
   `CesiumDebug.showFrustums()` / command-count overlay to see whether the voxel command is even
   executed. Baseline expectation: WebGL renders interior at all waypoints; WebGPU black at
   0.9R/0.55R/0.05R. READ the PNGs.
2. **Bisect the three suspects cheaply, in order:**
   a. *Scene-level cull*: from the probe, dump whether the voxel `WebGPUDrawCommand` reaches the
   frustum bin (command-count per pass; or a debug counter in the FR update). If the command
   vanishes when inside → BV/cull fix in the command emission (check `cull`/`boundingVolume` on the
   voxel command; camera-inside-BV must never cull).
   b. *Near-plane/cull-front geometry*: if the command executes but draws 0 fragments, test by
   temporarily (diagnostic only, NEVER landed) forcing `cullMode:"none"` — if pixels appear, the
   back-face path is clipped/culled; the correct fix class is the standard one WebGL uses: render
   back faces with `depthCompare` appropriate for inside views, or switch the interior case to a
   fullscreen-triangle entry (camera-inside ⇒ ray starts at near plane) — WebGL's VoxelFS handles
   this via `NearFarScalar`/ray-origin clamp, and the WGSL march already accepts `tStart=0`.
   A fullscreen-quad interior fallback selected by a CPU-side `cameraInsideVolume` test (camera
   position vs `u.minBounds/maxBounds` in shape space) is the smallest-surface fix that cannot
   regress the outside path (outside keeps the proxy cube byte-identically).
   c. *RTE vertex path*: if fragments draw but black, check the VS RTE reconstruction for
   interior/near-plane precision (positionHigh/Low vs camera — never absolute f32 ECEF).
3. **Fix in the smallest surface** that keeps the outside path byte-identical (off-gate: outside
   waypoint PNGs byte-identical pre/post; probe asserts it).
4. **Full preservation matrix** (the W1-18 acceptance): after the fix, run
   `probe-voxel-parity.mjs`, `probe-voxel-octree.mjs`, `probe-voxel-octree-l3plus.mjs`,
   `probe-voxel-cell-pick.mjs`, `probe-voxel-pick.mjs`, `probe-voxel-refined-pick.mjs`,
   `probe-voxel-megatexture.mjs` (PARTs 1–3), `probe-voxel-user-customshader.mjs`,
   `probe-voxel-ellipsoid.mjs`, `probe-voxel-cylinder.mjs` — ALL must stay green (color, object
   pick, cell pick, velocity/depth, octree, megatexture, custom shader legs).

**TRAPS.**

1. **Do NOT gate interior views off** ("camera inside → skip draw") — that is feature removal; the
   audit row explicitly forbids it. WebGL renders the interior; that is the parity bar.
2. **`cullMode:"none"` is a diagnostic, not a fix** — landing it doubles fragment work on the
   default outside path and can double-blend translucent accumulation. If the fix needs a different
   cull mode for the interior case, it must be a per-case pipeline variant with a distinct
   pipeline-cache name (see BUG-GLOBE-PIPELINE-NAME-AXES — name-collision class; the voxel pipeline
   names must encode the new axis).
3. **Ellipsoid/cylinder shapes**: `intersectShapeReal` dispatches per shape (`:808` comment) —
   verify the interior fix on BOX first, then confirm ELLIPSOID/CYLINDER interiors (hollow-cylinder
   inner interval at `probe-voxel-cylinder.mjs` is the nasty case: camera inside the HOLE is
   "outside the shape" for the march).
4. **PART-3 `pixelsMatch` sub-gate already FAILS at clean HEAD** (pre-existing since ~B526, verified
   pre-existing by A/B against a stashed tree — `DEFERRED_WORK.md:3394-3399`). Do not attribute
   that red to your change; the functional sub-gates (cappedAtlas/overDemandNoOverflow/evicted/
   reuploaded) are the ones that must stay green. Triage of `pixelsMatch` is A2's business.
5. **B693 one-frustum default**: interior views have tiny near distances — frustum count may differ
   from old captures; assert `numberOfFrustums` in the probe rather than assuming.

**VERIFICATION RECIPE.** New `probe-voxel-inside-camera.mjs` (waypoint ladder, both backends,
per-waypoint PNG read + non-black count + 0 device errors) = acceptance; outside-waypoint byte-identity
= off-gate; the ten-probe voxel battery above = preservation; no perf claim (correctness slice — no
moving-route run needed, but zero new per-frame allocations on the outside path).

**MODEL-TIER: fable** for the bisect/diagnosis leg (three live suspects, genuinely ambiguous), then
the fix itself is usually small enough to land in the same session. **Effort M** (register agrees).

---

### A2. PARITY-VOXEL-OCTREE-TRAVERSAL — P1, XL (slice it; do NOT open as one task)

**WHAT + WHY.** The rest of the voxel octree XL (`DEFERRED_WORK.md:3325` onward; FI §C.5:822 tail
note). Shipped so far (verified in the entry's own updates): depth-1 LOD (VOXEL-OCTREE-LOD,
9-slot atlas), STATIC atlas to LEVEL 3 (NEW-VOXEL-OCTREE-DEEP-LEVELS — 585-slot flat atlas, linear
`x + 8y + 64z`, gated by `probe-voxel-octree-l3plus.mjs`), dynamic LRU pool for the level-2 set
(NEW-VOXEL-ATLAS-LRU-EVICT, `probe-voxel-megatexture.mjs` PART 3), ellipsoid + cylinder shapes
feature-complete for single-tile providers (B22/B23/B24). **Remaining (the register row's real
content):** (1) levels deeper than 3 via the general `u_octreeInternalNodeTexture` GPU node-table
walk (`traverseOctreeDownwards` / `traverseOctreeFromExisting` ports) — flat per-level slot arrays
become impractical at level 4 (4096 slots); (2) generalize the LRU pool beyond level-2 (page
per-level slot tables through the pool) + a public `maximumTileCount` API (today the override is
fork-internal `_webgpuVoxelAtlasMaxSlots`); (3) ellipsoid/cylinder RENDER bounds (lon/lat wedges,
angle half-planes) + non-box multi-level refinement (deliberately box-gated in
`WebGPUVoxelDataUpload.ts` until verified); (4) `SAMPLE_COUNT > 1` leaf lerp
(`u_octreeLeafNodeTexture`) + time-dynamic keyframes; (5) **triage the PART-3 `pixelsMatch`
sub-gate red at clean HEAD** (stale pixel tolerance vs a real re-upload rendering drift —
`DEFERRED_WORK.md:3394-3399`).

**ARCHITECTURE TODAY (verified).** `WebGPUVoxelRenderer.ts` (march + `octreeDescend`, cap
`min(atlasInfo.y, 3)`), `WebGPUVoxelDataUpload.ts` (level-generic `driveTileLevelUploads`,
`driveDynamicL2Uploads`, box-gated multi-level refinement), UBO layout floats 108..119 (childSlots),
216-227 (cylinder), 228..739 (L3 slots — UBO already 2960 B). Probes:
`probe-voxel-octree.mjs`, `probe-voxel-octree-l3plus.mjs` (+ fixture `fixtures/voxel-octree-l4.mjs`),
`probe-voxel-megatexture.mjs`, `probe-voxel-ellipsoid.mjs`, `probe-voxel-cylinder.mjs` — all exist.

**IMPLEMENTATION WALKTHROUGH (slice plan — each its own batch, in this order).**

- **Slice 0 (S, do first): PART-3 `pixelsMatch` triage.** Rerun PART 3 at HEAD; diff the A1-vs-A2
  PNGs yourself. If the drift is a tolerance artifact → tighten/fix the probe (tooling slice). If
  re-upload genuinely renders differently → that is a data-path correctness bug that BLOCKS the LRU
  generalization; root-cause before slice 2. This is also the `--update` baseline-block hygiene for
  the suite.
- **Slice 1 (L): GPU node-table walk.** Port `traverseOctreeDownwards` semantics: build the
  internal-node texture upload (CPU mirror of upstream `VoxelTraversal` node pool) + WGSL walk
  replacing the flat `l3Slots` branch when `availableLevels > 4`. Off-gate: providers with
  `availableLevels <= 4` keep the flat-slot path byte-identically (`probe-voxel-octree-l3plus.mjs`
  green unchanged). New probe: `probe-voxel-octree-deep.mjs` with a 5-level fixture
  (extend `fixtures/voxel-octree-l4.mjs`).
- **Slice 2 (M): LRU pool generalization + public `maximumTileCount`.** Page per-level slot tables
  through the pool; expose the public API mirroring upstream. Off-gate: under-capacity scenes take
  the exact static path (PART 1+2 unchanged).
- **Slice 3 (M): non-box refinement un-gate.** Remove the box gate in `WebGPUVoxelDataUpload.ts`
  ONLY after slice-1 walk verifies on ellipsoid/cylinder fixtures; add render-bounds intersection
  (wedges) as its own sub-slice — `IntersectCylinder.glsl`/`IntersectEllipsoid.glsl` are the ports.
- **Slice 4 (M): SAMPLE_COUNT>1 lerp + time-dynamic keyframes** — last; needs a time-dynamic
  fixture provider.

**TRAPS.** (1) UBO growth: the 2960-B UBO is already large — a node-table TEXTURE is the right
container for deeper levels, not more UBO floats; don't grow the UBO past device limits. (2) The
`yUpBox` axis swap is BOX-only (Octree.glsl SHAPE_BOX-gated) — preserving that in the generalized
walk is a known bit-parity trap. (3) Inside-camera (A1) interacts: if A1's fix adds an interior
entry path, the deep walk must work from an interior `tStart=0` origin too — run
`probe-voxel-inside-camera.mjs` in this item's battery once A1 lands. (4) Add-only rules: any new
`ShaderDefine`/`ShaderSourceId` is add-only; bit ≥24 needs the keySalt rule only if source text
gains an identity dimension. (5) Do not let a worker "simplify" the flat-slot L1/L2/L3 paths away —
they are the off-gate for every existing probe.

**VERIFICATION RECIPE.** Existing five voxel octree/megatexture probes green per slice + the new
deep probe; `probe-voxel-user-customshader.mjs` + pick probes green (shared march). Promotion: none
(parity feature work).

**MODEL-TIER:** Slice 0 **fable** (ambiguous triage); slices 1–4 **opus-or-sol** (well-specified
ports with named references). **Effort XL total; slices S/L/M/M/M.**

---

### A3. NEW-CLASSIFIER-2D-CV-MORPH — P1, L

**WHAT + WHY.** WebGL classification primitives render in SCENE2D/CV/MORPHING; WebGPU classifier
renderers were progressively un-gated but a remainder stands (`DEFERRED_WORK.md:1373-1439`):
(1) `WebGPUVector3DTilePolylinesRenderer` + `WebGPUVector3DTileClampedPolylinesRenderer` still gate
SCENE2D + COLUMBUS_VIEW (need the CPU-reprojected ENU 2D vertex path, ~80 LOC each, adapted to
their attribute layouts); (2) MORPHING blend for `Vector3DTilePrimitive` (the polygon pipeline);
(3) GroundPrimitive 2D/CV **textured** variant (flat-color 2D/CV shipped B170 via the `.zxy`
swizzle; textured materials in 2D/CV never wired) + Image material in those modes.
`WebGPUGroundPolylineRenderer`'s dual-attribute + dedicated morph pipeline (B116/117) is the
verified template; `Vector3DTilePrimitive` 2D/CV itself shipped B178 but is **e2e-visual
UNVERIFIED** — blocked on the absence of a loadable classic `.vctr` classification scene (the
repo's vector samples are `CESIUM_mesh_vector` → BufferPolygon, a different renderer).

**ARCHITECTURE TODAY (verified).** `WebGPUVector3DTileClampedPolylinesRenderer.js:1142` gates
`sceneMode !== SCENE3D && sceneMode !== MORPHING` → skip with a warn (`:1147`); MORPHING allowed
through since B208 (comment `:1131`). Polylines renderer has the same shape (B207). GroundPrimitive:
`WebGPUGroundPrimitiveRenderer.js` mode-conditional `.zxy` swizzle in `colorVS`/`vsVelocity` (B170),
`morphColorVS` (B164), textured-material dispatch (`applyMaterial`/`surfaceUV`/`packExtents`).
Probes: `probe-classifier-scenemode.mjs` (ENFORCE_2D=true), `probe-classifier-textured-materials.mjs`,
`probe-groundprim-textured-classify.mjs` all exist.

**IMPLEMENTATION WALKTHROUGH.**

1. **Unblock verification FIRST (the long-standing blocker).** Build the missing test scene rather
   than shipping more unverifiable code: a minimal classic `.vctr` tile fixture. Two viable routes —
   (a) author a tiny `.vctr` binary fixture offline (the format is documented in the 3D Tiles
   vector-tile spec draft; the repo's `Vector3DTileContent` parses it) checked into
   `Apps/SampleData/vector-classic/`; (b) a Node-side builder in
   `Tools/visual-regression/fixtures/vctr-builder.mjs` that emits the tileset at probe start. This
   is its own S slice and unlocks THREE items (this one, C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES, and
   the B178 UNVERIFIED closure).
2. New probe `probe-vector3dtile-2dcv.mjs`: load the `.vctr` scene, flip 3D→CV→2D→morph on both
   backends, red-pixel-count parity per mode.
3. Port the B178 ENU 2D reprojection pattern to Polylines + ClampedPolylines (per-renderer
   attribute-layout adaptation; the VS math is mode-agnostic — only center/buffer/`vpRTE` differ).
4. MORPHING blend for `Vector3DTilePrimitive` via the GroundPrimitive `morphColorVS` EC-space
   pattern.
5. GroundPrimitive 2D/CV textured variant: the B170 swizzle already places the polygon; wire the
   textured-material UV path (extents/`fstate`) under 2D/CV and verify with a 2D Checkerboard case
   in `probe-classifier-textured-materials.mjs`.

**TRAPS.** (1) The DW entry records that for Vector3DTile* renderers **upstream WebGL also renders
wandering volumes in 2D/CV** (no mode check, silently wrong) — our gate is BETTER than upstream;
lifting it without the reprojection is a REGRESSION. Never just remove the gate. (2) B178's 2D
center convention: `camera.positionWC` under `TRANSFORM_2D` is ENU `(altitude, projX, projY)` — the
component-order garbage class (B169 lesson) reappears in every new renderer port; assert coverage
within ~6% of WebGL like `probe-classifier-scenemode.mjs` does. (3) One-frustum default (B693): 2D
band math is unchanged by C10-01 (proven no-op in 2D) but morph frames are transient — probe morph
at fixed `morphTime` waypoints, not mid-animation races. (4) The `.vctr` fixture must be offline —
no Ion/network dependency (NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION is a standing rule).

**VERIFICATION RECIPE.** New `probe-vector3dtile-2dcv.mjs` + existing scenemode/textured probes; 3D
byte-identity off-gate per renderer (mode ≠ 3D changes only); `capture-and-diff` battery unchanged.

**MODEL-TIER:** fixture slice **opus** (well-specified format work); renderer ports **opus-or-sol**
(line-for-line pattern ports with a verified template); only the morph blend leg is mildly
ambiguous. **Effort L total (S fixture + M ports + S morph).**

---

### A4. NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION — P1, M (maybe S) — **RE-VERIFY-FIRST**

**WHAT + WHY.** Two DISTINCT measured artifacts on textured GroundPrimitive classification
(`DEFERRED_WORK.md:1497-1523`): (a) far-corner degradation — Checkerboard degrades toward the far
corner of a large polygon (`windowToEye` catastrophic cancellation near `storedDepth ≈ 0.9999997`);
Stripe (1-D) hides it; (b) the B198 whole-polygon **UV frequency ~4× too fine** (a Stripe with
`repeat:10` shows ~30+ bands vs WebGL's ~10) — variance-blind probes passed while frequency was 4×
off. The item was PARKED behind "textured renders 0 px" (B375/B595) which was **root-caused 2026-07-10
as a PROBE-HARNESS RACE** (settle loops exited on `tilesLoaded`, which does not cover the globe
pipeline's ~1-2 s `createRenderPipelineAsync` — captures ran globe-less): with a globe-readiness
gate, textured classification RENDERS and converges (Stripe 16.7% / Checkerboard 5.2% / Grid 0.0% /
Image 7.3% polygon-ROI mismatch — FI §C.4:813). UNPARKED: the log-reverse consumer
(`csm_reverseLogDepthToEyeDistance` branch in `windowToEye`) has been live since B251, so the
far-corner case is finally measurable. Register status confirmed accurate at HEAD.

**ARCHITECTURE TODAY (verified).** `WebGPUGroundPrimitiveRenderer.js`: depth-sample classifier
(`windowToEye` with `logDepthActive`-gated log reverse ~:921 per B375 note — re-grep the symbol),
group-2 `FrustumState` UBO ring (`ensureFrustumStateSlot`/`writeFrustumState`, B173), material
dispatch (`applyMaterial`, analytic-derivative Grid lines, Image flipY fix, PRE_MULTIPLIED blend —
the four B637-era parity fixes). Acceptance probe `probe-groundprim-textured-classify.mjs` EXISTS
(globe-readiness-gated). The `czm_packDepth(1.0)==vec4(0)` no-surface sentinel ships in
`WebGPUGlobeDepth` + `WebGPUTranslucentTileClassification` packs.

**IMPLEMENTATION WALKTHROUGH.**

1. **Premise-verify (mandatory, cheap):** run `probe-groundprim-textured-classify.mjs` at HEAD and
   READ the Checkerboard far-corner ROI yourself. Three possible outcomes: artifact gone (log
   reverse fixed it) → close the row with the probe evidence + a far-corner ROI assertion added so
   it can't regress silently; artifact present → proceed; probe red for unrelated reasons →
   fix the probe first (one concern per slice: as a separate tooling commit).
2. If present: instrument `st` directly (debug output `vec4(fract(st),0,1)` behind a pragma) at the
   far corner; determine whether the residual tracks depth quantization (RGBA8 pack) or the
   reconstruction math. Post-B693 the frame is ONE frustum — the old per-slice mismatch explanations
   are dead; the live suspects are pack precision + `invProj` capture timing.
3. **Frequency assertion for (b):** extend the probe with a band-count (FFT or zero-crossing count
   along the stripe axis) oracle — variance is frequency-blind; this closes the B198 gap class
   permanently. If the 4× is still present, it shares the depth-reconstruction root — fix together.
4. Fix surface: `windowToEye` consumption of packed log depth (consumer-reverse precision), NOT the
   producer (globe log-depth production is B251-landed and owned elsewhere — the pick-fleet
   log-depth conversion `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` is C10-11's; do not touch pick encode).

**TRAPS.** (1) The history of this item is THREE wrong diagnoses (depth-precision red herring for
flat-render B171-174; "regression" that was a probe race B375/B595; per-slice/Link-4 framing killed
by the single-frustum correction B201) — do not trust any prior mechanism claim without re-measuring
at HEAD. (2) C10-11/C10-12 (pick-fleet log depth + depth-plane gate flip) are C10-owned and touch
the same depth-encode surfaces — check the C10 ledger at intake; if C10-11 landed, the depth
encoding your consumer reads may have changed since this guide. (3) The globe-readiness settle gate
(poll frustum-list GLOBE-pass commands) is MANDATORY in any new capture — `tilesLoaded` alone
reintroduces the false-zero. (4) Don't tighten the normalized probe gates while the tint drift
(PARITY-POINTCLOUD-COLOR-TINT, different cluster) is open — unrelated red risk.

**VERIFICATION RECIPE.** `probe-groundprim-textured-classify.mjs` far-corner ROI + new band-count
oracle; `probe-classifier-textured-materials.mjs`, `probe-classifier-scenemode.mjs`,
`probe-classifier-logdepth-flip.mjs`/`-settle.mjs` green; off-gate = near-camera cases byte-stable.

**MODEL-TIER: fable** (this is a verify-first diagnostic with a real chance the premise is already
resolved). **Effort M, S if step 1 closes it.**

---

### A5. C-R9-VOXEL-CELL-PICK-TAIL — P1→**PREMISE-STALE (register row is out of date)** — S

**WHAT THE REGISTER SAYS vs HEAD.** Register: *"`scene.pickVoxel` (public API) still throws —
WebGPU path never builds `_traversal` (findKeyframeNode TypeError)."* Source cited: FI §C.5
(`FEATURE_INVENTORY.md:822`) — and the DEFAULT_PARITY_MATRIX row 7 repeats it. **This is RESOLVED
in code and in DEFERRED_WORK:** `DEFERRED_WORK.md:3468` marks `~~C-R9-VOXEL-CELL-PICK-TAIL~~ —
RESOLVED (2026-07-04)`: `Scene.pickVoxel` routes through backend-agnostic
`VoxelPrimitive._getPickKeyframeNode(tileIndex)`; **verified live at HEAD**: `Scene.js:4452` calls
`voxelPrimitive._getPickKeyframeNode(tileIndex)`; `VoxelPrimitive.js:659` defines it;
`WebGPUVoxelRenderer.ts:3539` `getVoxelPickKeyframeNode` (exported `:3664/:3669`); FR registration
`WebGPUFeatureRenderers.ts:699`. Refined-tile VoxelCell construction also RESOLVED
(NS-VOXEL-REFINED-TILE-CELL-RETENTION, 2026-07-05, `DEFERRED_WORK.md:3518`). Acceptance probes
exist and were green at resolution: `probe-voxel-pick.mjs`, `probe-voxel-cell-pick.mjs`,
`probe-voxel-refined-pick.mjs`. **FEATURE_INVENTORY §C.5:822 and DEFAULT_PARITY_MATRIX row 7 are
stale and must be corrected as part of closing this row.**

**THE REAL REMAINING TAIL (what a C11 slice should actually be):** the documented residual at
`DEFERRED_WORK.md:3506-3516` — over EMPTY columns / off-box pixels, WebGPU's OBJECT pick
(`scene.pick`, which `pickVoxel` calls first) returns the voxel primitive across the whole proxy-box
footprint where WebGL returns `undefined`, so `pickVoxel` yields a **spurious root cell** there
(pre-fix those pixels threw; now they return a valid-looking cell). A cleared readback `[0,0,0,0]`
is indistinguishable from a real tile-0/sample-0 hit on BOTH backends, so the fix is in the
**object-pick footprint** (make the voxel object-pick miss empty columns like WebGL — likely the
pick march writing pick color for zero-alpha march results), not in the cell-pick decode.

**WALKTHROUGH.** (1) Premise-verify: run the three voxel pick probes at HEAD — expect green (if NOT,
stop: a C10-11 pick-fleet change may have altered pick encode; bisect before anything).
(2) New probe `probe-pickvoxel-footprint.mjs`: pick at filled cell (both return cell), empty column
inside box footprint (WebGL undefined, WebGPU currently spurious cell — the RED assertion), and
off-box (both undefined). (3) Fix in the voxel pick march: only emit pick color when the march
accumulates non-zero alpha (mirror WebGL VoxelFS discard semantics); verify `fragmentPickVoxelMain`
and the OBJECT-pick main agree. (4) Doc closure: strike the stale FI §C.5 + matrix row text.

**TRAPS.** The pick-fleet log-depth conversion (C10-11, in flight) owns pick frag_depth — this slice
must not touch depth encode, only the discard/alpha gate. Interaction with A1: an interior camera
changes the march interval — run the footprint probe from outside only until A1 lands.

**MODEL-TIER: opus** (well-specified once the premise-verify passes). **Effort S.**

---

### A6. C-R1-CLASSIFICATION — P1, M — **decision-entangled with ADR-2026-04-28 (A9)**

**WHAT + WHY.** FI §C.2:787: *"ClassificationPrimitive needs the upstream 3-pass renderState set
(stencil-depth / color / pick) routed through WebGPU pipeline variants — stencil semantics currently
approximated."* Register status WIP.

**ARCHITECTURE TODAY (verified).** The fork **deliberately migrated away** from the 2-pass stencil
approach: `WebGPUGroundPrimitiveRenderer.js:5-26` docstring — *"migrating from a 2-pass stencil
approach … to a depth-texture sampling"* (ADR-2026-04-28); the legacy stencil VS/FS + 3-pass
descriptors are **compiled-but-unused fallback** (`:699-737` builds stencil/color/pick descriptor
trio; commands "fall back to skip dispatch rather than stencil"); `dsStencilFS` at `:1202` exists
for invert-classification stencil marking (A.2/B141). So the literal FI framing ("route the 3-pass
renderState") describes the road NOT taken — the honest scope of this row today is:
**(a)** verify the depth-sample classifier reproduces the upstream 3-pass OBSERVABLE semantics
(depth-tie behavior, translucent-feature depthMask flip, invertClassification stencil interplay,
pick pass results) — `probe-classification-primitive-parity.mjs` exists as the vehicle; **(b)** either
finish wiring upstream `command.renderState` deltas into the WebGPU pipeline variants where the
depth-sample path consumes them (blend, stencil-for-invert, depthMask), or record the deliberate
divergence per-semantic; **(c)** delete NOTHING — the unused stencil pipeline trio is Principle-7
scaffolding for the fallback path.

**WALKTHROUGH.** (1) Premise-verify with `probe-classification-primitive-parity.mjs` at HEAD; read
diffs. (2) Enumerate upstream `ClassificationPrimitive._rsStencilPreloadPass/_rsColorPass/_rsPickPass`
state (upstream `ClassificationPrimitive.js`) → build a semantic checklist → per-semantic WebGPU
behavior test (invertClassification ON is the discriminator scene: `invertClassification=true` +
`invertClassificationColor`). (3) Wire real gaps through the existing pipeline-variant machinery
(distinct cache names per state axis — the BUG-GLOBE-PIPELINE-NAME-AXES lesson applies verbatim).

**TRAPS.** (1) This row and A9 are the same architecture decision surface — schedule them on the
same worker or sequence A9's accumulation completion AFTER this audit (a stencil-semantics fix that
ignores the paused multi-frustum composite can be invalidated by it). (2) B699 translucent-twin
gating changed which tile commands even exist for styled/translucent features — the depthMask-flip
semantics test must use a styled tileset to force the twins. (3) Do not resurrect the stencil path
as the "fix" — the ADR is the ratified direction; parity is judged on OUTPUT.

**VERIFICATION RECIPE.** `probe-classification-primitive-parity.mjs` + an invertClassification case
(extend it or add `probe-invert-classification.mjs`); `probe-classifier-scenemode.mjs` green;
`capture-and-diff` battery.

**MODEL-TIER: fable** for the semantic audit (judgment calls on match-vs-document per semantic),
opus for the wiring after. **Effort M.**

---

### A7. NEW-GS-CLASSIFICATION-DEPTH — P2, M — **BLOCKED-BY-PRODUCER (re-scoped at HEAD)**

**WHAT + WHY.** FI §C.4:814: Gaussian-splat translucent tiles classify against globe-depth instead
of splat-depth — classification polygons land on terrain rather than splat geometry. Register: WIP.

**PREMISE AT HEAD — the ground has moved.** B696 (C10-04) confirmed and filed
`NEW-WEBGPU-SPLAT-DATA-PRODUCER` (`DEFERRED_WORK.md:23`): the WebGPU splat FR has **no production
data producer** — `GaussianSplatPrimitive.update()` returns before `commitSnapshot`, `_splatData`
is never assigned in production, the renderer is SCAFFOLDED-not-SHIPPED, and its only exerciser is
the synthetic `probe-splat-sort.mjs`. **Therefore GS-classification-depth cannot be exercised
end-to-end on WebGPU today**: there are no production splat draws to classify against. Verified
corroboration: `WebGPUTranslucentTileClassification.ts` contains zero splat references (grep).

**DISPOSITION.** Do NOT open as an independent C11 slice. Sequence strictly AFTER
`NEW-WEBGPU-SPLAT-DATA-PRODUCER` (splat cluster, G-guide for cluster 3) lands. What CAN be done
now (S, optional): a design note + probe skeleton `probe-gs-classification-depth.mjs` (classification
polygon over a synthetic splat via the probe-splat-sort injection path — decide whether the
injection path renders enough to measure classification landing depth; if yes, the probe can go RED
now and gate the eventual fix). Depth-source mechanics when unblocked: route the classifier's
depth-source resolver to the splat depth (the ADR depth-sampling classifier reads a depth view —
the distinct-depth-source-per-pass plumbing that A8 also needs; build it ONCE for both).

**MODEL-TIER:** n/a until unblocked; probe-skeleton slice **opus**, S. Flag to orchestrator:
cross-cluster dependency (splat producer).

---

### A8. C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES — P2, M

**WHAT + WHY.** FI §C.4:816 — three residuals on the WebGPU clamped-polylines classifier:
(1) per-feature pick slot reserved but never written (per-feature pick returns nothing);
(2) distinct depth-source per pass not routed (the classifier should sample a per-pass depth —
globe-only vs globe+tiles — matching upstream's `Vector3DTileClampedPolylines` pass split);
(3) `DEBUG_SHOW_VOLUME` unimplemented. Register WIP; the 2026-06-05 forward-dated sweep confirmed
the parent entry genuinely resolved-in-code for its shipped half, these residuals stand.

**ARCHITECTURE TODAY (verified).** `WebGPUVector3DTileClampedPolylinesRenderer.js` exists; mode gate
at `:1142` (A3 owns lifting it). MORPHING allowed (B208). The per-feature pick slot reservation is
in the renderer's vertex packing (grep `batchId`/pick slot in the file at execution time).

**WALKTHROUGH.** (1) **Blocked on the same `.vctr` fixture as A3** — build A3's fixture slice first
(clamped polylines need a `.vctr` with polyline features). (2) Per-feature pick: write the reserved
slot from the batch table (mirror `WebGPUVector3DTilePrimitiveRenderer`'s working per-feature pick),
verify via `pickAsync` returning the correct `Cesium3DTileFeature`. (3) Depth-source per pass: this
is the same resolver A7 needs — implement as a shared depth-source parameter on the classifier bind
group resolver (the `_globeDepthView`-publish pattern, B173 precedent). (4) `DEBUG_SHOW_VOLUME`:
straightforward debug pipeline variant; pragma-wrapped.

**TRAPS.** Depth-source routing must respect the B637 no-surface sentinel (`czm_packDepth(1.0) ==
vec4(0)`) — a new depth source that doesn't emit the sentinel resurrects the sky-discard class of
bugs. One-frustum default: per-pass depth in a single-frustum world is simpler — don't build
multi-slice machinery C10-01 just deleted the need for (keep it per-PASS, not per-frustum).

**VERIFICATION RECIPE.** A3's `probe-vector3dtile-2dcv.mjs` scene reused; add a pick assertion +
DEBUG_SHOW_VOLUME visual case; existing classification battery green.

**MODEL-TIER: opus-or-sol.** **Effort M** (after the fixture exists).

---

### A9. ADR-2026-04-28 (incl. C-R8-TRANSLUCENT-MULTI-FRUSTUM) — P2, L — the Principle-7 origin

**WHAT + WHY.** FI §C.4:812/:817 — the depth-sampling classifier migration is mid-flight; the
volumetric/translucent tile classification **multi-frustum accumulation is paused**: Batch-47
scaffolding (accumulation texture + composite pipeline) awaits its producer half. This is the
literal origin story of CLAUDE.md Principle 7 — the scaffolding was nearly deleted once already.

**ARCHITECTURE TODAY (verified at HEAD).** `WebGPUTranslucentTileClassification.ts` docstring
(`:17-26`, `:54`): translucent classification currently draws *"directly into scene color, so the
prior accumulation-FBO + composite [path is inert]… nothing now calls `composite()`"*; scaffolding
present and intact: `_classificationColorTexture` (`:247`, allocated at `:384`),
`_compositePipeline`/`_compositeBGL`/`_compositeBindGroup`/`_compositeShaderModule` (`:268-273`).
**Do not let any worker delete these** — they are the declared Batch-47 deliverable surface.

**WALKTHROUGH (when opened).** (1) Decide the completion shape against TODAY's frame graph: the
original multi-frustum accumulation rationale predates B693's one-frustum default — at defaults
there is now exactly ONE frustum, so the accumulation's value is confined to genuinely multi-frustum
frames (sky-only fallback 2-frustum frames have no translucent classification; `pickFromRay`
offscreen renders; future >1e18 ratio scenes; non-log-depth configs). Re-derive the requirement:
either (a) complete the producer half (render translucent classification INTO
`_classificationColorTexture` per frustum, then `composite()` once) for exactness under
multi-frustum, or (b) record a reasoned retirement of the accumulation WITH maintainer sign-off
(charter: scaffolding removal needs the follow-up work's disposition decided, not silent deletion).
Recommendation: (a) is small now that frusta are usually 1 — the composite is a no-op-cost single
fullscreen pass on the rare multi-frustum frame; (b) requires the same analysis anyway.
(2) If (a): wire the producer, then the composite as a **registered scene-color consumer** under the
B697 demand-resolve regime (see traps). (3) The broader ADR migration line-items (depth-sample
classifier for remaining primitive classes) continue independently — keep slices one-concern.

**TRAPS.** (1) **B697 demand-resolve interaction is the #1 hazard**: the open
`NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING` finding (DEFERRED_WORK ~5395) documents exactly how a later
re-dirty + demand resolve can overwrite a mid-frame composite in `_sceneColorView`; a resurrected
translucent-classification composite has the identical shape. The composite must either run at the
post-frustum chain point where scene color is settled, or register consumption so the resolve
ordering is explicit. (2) B699 twin gating: translucent tile commands only exist when
`styleCommandsNeeded` — the acceptance scene must style features translucent. (3) One-frustum
default means the multi-frustum path is UNTESTED by default probes — the acceptance probe must
force ≥2 frusta deliberately (e.g. a custom near/far spanning >1e9 ratio scene or documented probe
hook), otherwise the composite lands dead-on-arrival-untested.

**VERIFICATION RECIPE.** New `probe-translucent-classification-composite.mjs`: styled translucent
tileset + classification, forced multi-frustum leg + default single-frustum leg, WebGL parity diff,
plus the C10-03 kill-switch A/B (`_sceneColorResolveElisionEnabled=false`) to prove no
resolve-ordering dependence. Existing classification + OIT-adjacent probes green.

**MODEL-TIER: fable** for the (a)-vs-(b) analysis + frame-graph placement (judgment, cross-system);
opus for the wiring after. **Effort L.**

---

### A10. VOXEL-USER-CUSTOMSHADER-RESIDUALS — P2, M

**WHAT + WHY.** `DEFERRED_WORK.md:5156-5167`. The native-WGSL voxel customShader path SHIPPED
(B503-era: `WebGPUVoxelCustomShaderCodegen.ts`, `VOXEL_USER_CUSTOM_SHADER` define — verified at HEAD
`WebGPUShaderDefines.ts:808` `1 << 29`, chunk-hash keySalt per the ≥bit-24 rule). Residuals:
(1) **customShader `uniforms` incl. SAMPLER_2D color-maps fall back to warn+default-gray** — this
breaks the UPSTREAM AUTO-BUILT viridis ramp for scalar metadata (`buildVoxelCustomShader`'s SCALAR
branch uses `u_colorMap`/`u_minimumValue`/`u_maximumValue`), i.e. a default-styling parity gap, not
just a user-API gap; (2) only the FIRST metadata property exposed (`fsInput.metadata` single field —
paired with the megatexture single-property upload); (3) no `fsInput.voxel.*` block
(travelDistance/stepCount/tileIndex/sampleIndex/…) nor `positionEC`/`viewDirUv`; (4) vertex-stage
voxel customShaders — parity holds (WebGL doesn't either), noted only.

**ARCHITECTURE TODAY (verified).** `WebGPUVoxelCustomShaderCodegen.ts` exists; per-shader pipeline
names (`Voxel color pipeline (userCustomShader#<hash>)`) handle mid-session swap; probe
`probe-voxel-user-customshader.mjs` green at ship time. Fix shape for (1) is pre-designed in the
entry: a voxel BGL/pipeline-layout VARIANT with a custom-shader UBO at `@group(0) @binding(3)`
(+ texture/sampler bindings), reusing `CustomShaderWGSLPipelineStage.packUniformBuffer` vec4-slot
packing, rebuilt on the same seam the real-data texture swap uses.

**WALKTHROUGH.** (1) Residual (1) first — it is the parity-visible one (scalar-metadata voxel
tilesets render gray instead of viridis on WebGPU): implement the BGL variant + UBO pack + sampler
binding; acceptance = the upstream auto-ramp renders (extend `probe-voxel-user-customshader.mjs`
with a no-user-shader scalar-provider case asserting non-gray ramp colors matching WebGL).
(2) Residual (2) as its own slice (multi-property upload in `WebGPUVoxelDataUpload` + multi-field
metadata struct in codegen — data-path + codegen must land together). (3) Residual (3) lanes
on-demand, S each — do not speculatively build all of `fsInput.voxel.*`.

**TRAPS.** BGL variant means a NEW pipeline-layout axis → pipeline cache names must encode it
(name-axes lesson). The bind-group rebuild seam must survive mid-session customShader swap BOTH
directions (set→clear→set) — the shipped path already handles swap; keep its probe legs green.
Multi-property upload grows the 3D atlas — interacts with A2 slice 2 (LRU pool); coordinate if both
open. Off-gate: shaders without uniforms keep the current layout byte-identically.

**VERIFICATION RECIPE.** `probe-voxel-user-customshader.mjs` extended (auto-ramp case + uniforms
case + swap/clear legs); voxel battery green; off-gate preprocess(0) byte-identity per the shipped
pattern.

**MODEL-TIER: opus-or-sol** (fix shape pre-designed in the entry). **Effort M (residual 1), S–M each
for the rest.**

---

## PART B — postprocess-effects cluster

### B1. C9-23-EFFECT-EXECUTION-AUDIT / FAR-500-C0 — P1, M — **the Wave-3 gateway; open first**

**WHAT + WHY.** C9 queue §7 W3-36 (`QUEUE_2026-07-15_CAMPAIGN9.md:238`): *"Audit every fullscreen,
compute, shadow, cloud, weather, ocean, flow, and capture owner for explicit
enabled+consumer+view demand. Add execution counters and conservative fallback; do not octree-cull
global viewport effects."* Coupling recorded at `:85`: fullscreen/compute work does not inherit
primitive PVS automatically. This is the R0/R1 gateway that SCOPES the whole visibility family
(C9-20 FFT-ocean continuity, C9-21 flow-field, C9-22/22A env-capture — all unexecuted, all
downstream of this audit; they are NOT in this cluster's list but your audit output feeds their
briefs). NOT STARTED — verified no execution-counter registry exists for effect owners at HEAD.

**ARCHITECTURE TODAY (verified owner inventory).** Effect owners at HEAD (all files exist):
`WebGPUSceneRendererEnvironmentalEffects.ts` (fog/clouds/env consume path),
`WebGPUSceneRendererPostFrustumChain.ts` (post-frustum fullscreen chain),
`WebGPUPostProcessPipeline.ts` (+ `WebGPUPostProcessStageCollection.ts` sync,
`WebGPULibraryPostProcessStage.ts` interception), `WebGPUAutoExposure.ts` (2 compute passes +
readback ring — see B3), `WebGPUOceanRenderer.ts` (FFT chain, ~35 compute passes, private submit —
FAR-200 seed), `WebGPUFlowFieldRenderer.ts` (advect compute), weather/cloud renderers,
`WebGPUDynamicEnvironmentMapCapture` (runSceneCapture), shadow map passes, `WebGPUSSGI` path via the
AO stage (`algorithm:"ssgi"`), TAA/velocity legs. The demand-record precedent to follow:
`WebGPUAttachmentDemandRegistry.ts` (C9-09, B681) — per-frame demand record + truthful reporting +
observe-before-act.

**IMPLEMENTATION WALKTHROUGH.**

1. **Inventory pass (read-only deliverable):** per owner, record: enable flag(s), consumer(s), view
   dependence, current execution gate, and whether it can run with zero consumers. Output as a
   table in the audit report + a machine-checkable manifest (the C9-02 cohort-manifest pattern).
   The B14-style findings (AutoExposure running unconsumed at SDR — B3 below) are exactly what this
   pass exists to surface; expect more (e.g. velocity pass under no-TAA, Hi-Z build under no
   consumer — check against FAR-003 containment which already fail-closes some).
2. **Execution counters:** pragma-stripped per-owner dispatch counters surfaced via a
   `CesiumDebug.effectDemand()` (mirror `CesiumDebug.attachmentDemand()`); permanent sentinels only
   where a real error class exists (per the logging pragma rules). Update DEBUGGING_GUIDE.md in the
   same commit (drifted-guide rule).
3. **Conservative fallback wiring:** where demand is UNKNOWN, the effect keeps executing (rule 3);
   only provably-zero-consumer dispatches get gated, each with its own on/off/restored oracle.
   **Never octree-cull global viewport effects** (the queue's own hard rule — fullscreen passes are
   not PVS-cullable).
4. Each gating that changes actual execution is its OWN slice (one concern) with a named oracle —
   this task's landing is the audit + counters + at most the trivially-safe gates.

**TRAPS.** (1) The temptation to "fix" every finding inline — don't; file rows (Principle 9), land
the audit. (2) B697 resolve-elision means "reads scene color" is now demand-tracked — your consumer
inventory must agree with the C10-03 consumer set or the two records will drift. (3) Ocean/weather/
cluster private submits are FAR-200 territory (submit-residency cluster) — note them, do not move
them here. (4) Effects that look unconsumed may be scaffolding (Principle 7) — cross-reference
FEATURE_INVENTORY before labeling anything dead.

**VERIFICATION RECIPE.** Audit manifest + counters land with zero behavior change (byte-identity on
`capture-and-diff` battery + moving-route neutrality); each safe gate proves: ON=off-path
byte-identical, OFF(effect enabled)=pixels unchanged with dispatch count dropping, RESTORED=counters
return. Propose `probe-effect-execution-audit.mjs` asserting per-owner dispatch counts on a matrix
of flag combinations (defaults / each effect on / all on).

**MODEL-TIER: fable** (cross-system judgment; the audit IS the deliverable). **Effort M.**

---

### B2. sunBloom-inert-on-WebGPU — matrix row 3 — P1 (folded in per cluster direction)

**WHAT + WHY.** From `DEFAULT_PARITY_MATRIX.md` row 3 (fresh, 2026-07-18, static sweep at B698):
`scene.sunBloom` **defaults TRUE** (`Scene.js:556`) and on WebGL runs the legacy SunPostProcess
glare chain whenever the sun is visible; on WebGPU the flag is **INERT** — `supportsLegacySunBloom`
returns false so SunPostProcess is never allocated, and `scene.sunBloom` is read NOWHERE under
`Renderer/WebGPU` (grep: zero hits, re-verified at HEAD). The substitute is a disc+glow+six-burst
baked into the procedural sun texture (`WebGPUEnvironmentRenderer.js` — B214 work), and the
capability-comment's claim that PP Bloom/LensFlare "handles it" is **not true at defaults** (both
default OFF). Status: DOCUMENTED guard (AUDIT_2026_05_02 C.12 — added to stop WebGL FB/shader leaks
on WebGPU viewers) but **NO parity-gap tracking row exists** despite being a default-ON visual
feature whose toggle silently does nothing. Consequence: different sun appearance in any
sun-in-frame view at defaults; `sunBloom=false` changes WebGL output, does nothing on WebGPU.

**ARCHITECTURE TODAY (verified at HEAD).** `GraphicsContext.ts:942` base getter
`supportsLegacySunBloom`; `WebGPUContext.ts:1654` override → false. `WebGPUEnvironmentRenderer.js`
bakes disc/glow/flare into the sun texture (B214, `probe-sun-pixel-check.mjs` exists, plus
`probe-sun-lens-glare.mjs` / `probe-sun-glowfactor.mjs` / `probe-sun-stars-extinction.mjs`).
WebGPU PP has a real Bloom (`WebGPUPostProcessPipeline.ts:1033 addBloom`) and an intercepted
LensFlare twin (`WebGPULibraryPostProcessStage.ts` + `LensFlare.wgsl`).

**IMPLEMENTATION WALKTHROUGH.**

1. **File the missing parity-gap row first** (the matrix's own recommended action) — this item is
   currently untracked in DEFERRED_WORK; a worker landing anything here must create the row in the
   same commit.
2. **Runtime evidence (matrix runtime-plan item 4):** new `probe-sunbloom-parity.mjs` — sun-in-frame
   saved view; WebGL sunBloom true/false A/B (delta EXPECTED — quantify it) vs WebGPU sunBloom
   true/false A/B (delta expected ZERO — proves inertness). These four PNGs are the decision input.
3. **Decision fork (surface to maintainer with the PNGs, don't pick silently):**
   (a) *parity-restoring wire* — make `scene.sunBloom` drive a WebGPU screen-space glare: gate a
   sun-region bloom via the existing PP Bloom (or a dedicated brightpass keyed off the sun's
   screen position, which `WebGPUEnvironmentRenderer` already computes) so the flag's true/false
   delta exists and visually approximates WebGL's spill-beyond-the-quad + horizon partial-occlusion
   glow; or (b) *ratify the baked-texture substitute* as the WebGPU look and make `sunBloom=false`
   at least degrade the baked glow (so the toggle is honest), documenting the divergence.
   The charter default leans (a): the flag is a public API whose contract is "toggle the glare".
4. If (a): implementation keys on the existing bloom infrastructure — do NOT resurrect the WebGL
   SunPostProcess chain against WebGPU (the C.12 guard exists precisely because that chain leaks
   WebGL resources); a WGSL sun-glare stage in the PP chain, enabled iff `scene.sunBloom &&
   sun visible`, default matching today's pixels as closely as the probe can hold (any intentional
   default-pixel change needs the maintainer sign-off from step 3).

**TRAPS.** (1) Default-pixel changes on the DEFAULT path are visual policy — same class as the
C10-03R MSAA reserve: get the ratification recorded before landing anything that changes the
default sun. (2) HDR interplay: the sun disc under HDR + autoexposure (B3) shifts luminance —
capture probe legs at SDR defaults AND HDR to avoid another operator-gap confound. (3) The baked
texture already contains a six-burst flare — adding PP bloom on top can DOUBLE the glow; the wire
must rebalance, which is exactly why the probe must read the PNGs against WebGL rather than assert
"something got brighter". (4) `probe-sun-pixel-check.mjs` baselines predate B698 mip changes —
recapture, don't compare stale PNGs.

**VERIFICATION RECIPE.** `probe-sunbloom-parity.mjs` four-way A/B as above; after any wire:
WebGPU true/false delta becomes non-zero and directionally matches WebGL's; sun-region parity
mismatch quantified and reported; env battery (`probe-atmosphere-orbit.mjs`, sun probes) green;
`capture-and-diff` unchanged for sun-out-of-frame scenes.

**MODEL-TIER: fable** for evidence + decision packaging (maintainer fork); **opus** for the wire
after ratification. **Effort M** (S for evidence + row; M for the wire).

---

### B3. AutoExposure-always-on-at-SDR — matrix row 14 — P2, S–M

**WHAT + WHY.** Matrix row 14 (SILENT class — in-code B.14 comment only, predates the
containment-policy era, no FAR/queue row): WebGL runs auto-exposure only under HDR tonemapping;
WebGPU calls `addAutoExposure` **unconditionally at pipeline init** and runs 2 compute passes +
readback ring **every frame at SDR defaults with the result unconsumed** (tonemap consumer disabled
at SDR). Verified at HEAD: `WebGPUSceneRendererEnsureResources.ts:492-508` — the B.14 comment
verbatim ("SDR scenes still need adaptive exposure for day/night cycles… Always-on autoexposure is
cheap") and the unconditional `host._postProcess.addAutoExposure(...)` at `:504`;
`WebGPUAutoExposure.ts:42-62` altitude-gate options (orbit floor default 0.75). Matrix recommended
action: **fix-silent-divergence** — file a tracking row; demand-gate the dispatch when no consumer
is enabled; ratify the HDR altitude-gate behavior separately (WebGPU's altitude gate is a visual
policy difference vs WebGL in non-default HDR mode).

**WALKTHROUGH.** (1) File the tracking row (same-commit rule). (2) Demand-gate: dispatch the two
compute passes only when a consumer exists (tonemap active under HDR, or any stage reading the
exposure value — enumerate consumers via B1's audit; this slice is a natural B1 rider). Keep the
ring/statistics allocation lazy on first demand. The B.14 rationale (SDR day/night adaptation)
concerns a path the SDR default cannot express while tonemap is off — but per rule 3, verify with
`CesiumDebug.gpuPassCost` + a forced moon→sun clock advance at SDR that pixels are truly identical
with the dispatch gated (if ANY SDR consumer is found, keep it running and record why).
(3) Separately: write the ratification request for the HDR-mode altitude gate (keep behavior; it
predates policy — needs a §3.3-style record, not code).

**TRAPS.** Do not remove the feature (HDR mode + `enableMoonLight` transitions genuinely need it);
the gate is demand-driven, not deletion. First-HDR-enable latency: the lazy path must warm the
exposure ring before the tonemap consumes it or the first HDR frames flash — mirror how the
pipeline already rebuilds on HDR flip (`:434-439` comment: HDR flip destroys/recreates the
pipeline — the gate can key off the same signal). Matrix row 12 (usePostProcess always-on) is
**keep-ratified** backend contract — don't confuse the two.

**VERIFICATION RECIPE.** New `probe-autoexposure-sdr-demand.mjs`: SDR defaults → autoexposure
dispatch count 0 (was >0), pixels byte-identical; HDR on → dispatches resume, adaptation behavior
unchanged vs pre-change HDR captures; SDR clock-advance leg pixel-identical. `gpuPassCost` dump as
the counter oracle. Perf: claimable only via moving-route if pursued; otherwise land as
correctness-parity with counter evidence.

**MODEL-TIER: opus** (well-specified; consumer enumeration comes from B1). **Effort S–M.**

---

### B4. usePostProcessSelected-hardwired-false — matrix row 19 — P2, M→L (shares plumbing with B5.2)

**WHAT + WHY.** Matrix row 19 (SILENT — "no recorded rationale; the definition of a silent
divergence"): WebGL computes `usePostProcessSelected = usePostProcess && postProcess.hasSelected`
(`FramebufferOrchestrator.js:137-138`) and routes selected-feature PP stages (silhouette-on-selected
etc.) through the selected composite path; WebGPU hardwires `environmentState.usePostProcessSelected
= false` **every frame** — verified at HEAD `WebGPUContext.ts:4109`. Invisible at defaults (no
selected stages), wrong the moment a user adds one. This is the SAME missing infrastructure as
WIRE-PP-LIBRARY-BUILTINS residual 2 (`CZM_SELECTED_FEATURE` masking for EdgeDetection/Silhouette/
BlackAndWhite, `DEFERRED_WORK.md:5093`) — pick-id/selected-texture plumbing. Treat them as ONE
plumbing epic with two consumers.

**WALKTHROUGH.** (1) File the tracking row (none exists). (2) Interim honesty slice (S): a one-time
pragma-warn when a WebGPU scene sets `stage.selected`/adds a selected stage — closes the silent
swallow while the plumbing is built (the same pattern the user-GLSL-stage warn used, B133).
(3) The plumbing (L): build the selected-feature texture (rasterize selected pick-ids into an R8/
stencil-like mask — the WebGPU pick-id infrastructure exists in the pick pass; render selected
features' ids to a small mask target), publish it to the PP bind-group resolver set, implement
`czm_selected()` semantics in the WGSL twins, and compute `usePostProcessSelected` truthfully from
`postProcess.hasSelected`. (4) Consumers: EdgeDetection/Silhouette/BlackAndWhite twins consume the
mask (B5's residual 2 closes for free).

**TRAPS.** The mask render must not run when no selected stage exists (that would be a new
always-on cost — exactly the class B1/B3 remove); demand-gate from birth. The pick-fleet log-depth
conversion (C10-11) touches pick-id producers — check its ledger state before building on pick-id
rasterization; coordinate encodings. Never rasterize the mask at internal-res assumptions (future
FSR2 R/D split — keep dims derived from the canonical target provider).

**VERIFICATION RECIPE.** New `probe-pp-selected-masking.mjs`: scene with two models, one selected;
Silhouette stage with `selected=[feature]` — WebGL masks to the selected model; WebGPU currently
processes whole-frame (RED baseline); after plumbing, parity diff on the masked region; no-selected
leg byte-identical + zero mask passes (counter). `probe-pp-library-builtins.mjs` stays green.

**MODEL-TIER:** warn slice **opus** (S); plumbing **fable-then-opus** (design of the mask target
and resolver contract has open choices). **Effort M–L.**

---

### B5. WIRE-PP-LIBRARY-BUILTINS-RESIDUALS — P2, M

**WHAT + WHY.** `DEFERRED_WORK.md:5086-5097`. The library built-in interception mechanism SHIPPED
(7 `czm_*` stages → WGSL twins via `WebGPULibraryPostProcessStage.ts`; probe
`probe-pp-library-builtins.mjs` 7/7 cross-backend). Residuals: (1) **LensFlare dirt/star textures
not ported** — verified at HEAD: `LensFlare.wgsl:14` *"`dirtTexture` overlay not implemented"* and
`:157` omission note; fix shape pre-designed (load `Assets/Textures/LensFlare/{DirtMask,StarBurst}.jpg`
at stage init, extend bind group + `LensFlareUniforms`, port dirt-tile/star-rotate math; M);
(2) `selected` masking — **now owned by B4's plumbing epic** (do not duplicate);
(3) DepthView encoding divergence — documented, within tolerance; only chase if a consumer needs
numeric depth-vis parity (also note its WebGPU depth copy lacks point-primitive depth);
(4) intercepted library stages execute AFTER all user WGSL stages instead of interleaved in
`collection._stages` order — S fix (merge into one ordered list) **only if a real scene bites**.

**WALKTHROUGH.** Open residual (1) as the slice: texture loads are async — 1×1 fallback until ready
(the GroundPrimitive Image-material pattern); dirt tile + star rotation math ports from upstream
`LensFlare` GLSL; extend `probe-pp-library-builtins.mjs`'s LensFlare leg with a dirt-visible
assertion (the ghost-chain geometry is already pixel-matched — keep that leg untouched). Residuals
(3)/(4): document-only unless demanded; if (4) is opened, it is a list-merge in
`WebGPUPostProcessStageCollection.ts`'s configure pass with a mixed-order probe case.

**TRAPS.** Asset licensing: the dirt/star JPGs are upstream Cesium assets (already Apache-2.0
in-tree) — use those paths, don't source new textures. HDR: lens flare runs pre-tonemap in HDR —
verify both SDR and HDR legs (B6's operator parity work shifted HDR pixels; recapture). The stage
uniforms carry texture URLs — a user can set custom dirt textures; honor the uniform, not a
hardcoded path.

**VERIFICATION RECIPE.** `probe-pp-library-builtins.mjs` extended; off-gate = stages disabled
byte-identical; cross-backend LensFlare mismatch % must DROP (the WGSL currently approximates star
factor as 1.0 → brighter ghosts; the port should converge).

**MODEL-TIER: opus-or-sol** (fix shape fully specified). **Effort M.**

---

### B6. NEW-PLAIN-HDR-SCENE-GAMMA-EPIC residual — P2, M

**WHAT + WHY.** `ROADMAP_AND_DEFERRED_WORK.md:659-734`. Increments 1+2 RESOLVED 2026-07-04 (globe/
points/billboards/models HDR gamma gates; mid-session HDR toggle invalidation; exposure sync;
ACES/Filmic/ModifiedReinhard operator math re-derived; per-instance color decode + batch-table
per-vertex color). **Open remainder (`:731-734`):** (a) the globe-imagery/**atmosphere/sky HDR
tonemap-operator gap** — `probe-plain-hdr-gamma.mjs` residual mismatch 11.96% (down from 92.59%)
attributed to the atmosphere/sky path not mirroring the HDR operator contract; (b) **MaterialAppearance
`*Lit.wgsl` + PBR primitive shaders don't apply the HDR color decode** (only basic/phong
per-instance-color shaders got the `hdrGamma` lane).

**ARCHITECTURE TODAY (verified).** Probes `probe-plain-hdr-gamma.mjs` + `probe-plain-hdr-tonemap.mjs`
exist. The landed pattern to replicate for (b): HDR-gated decode carried in a spare CameraUniforms
lane (`hdrGamma` — flat float 19 / lit float 51, packed in `writeRTEUniformsFlat/Lit`; 0 on SDR ⇒
byte-identical). For (a): the reference matrix is stated at `:667-669` — *under HDR every scene
shader emits LINEAR and the PP Tonemap does the single tonemap+gamma-encode*; the sky/atmosphere
WGSL needs auditing against that contract (inline tonemap/gamma not skipped under HDR is the
expected mechanism).

**WALKTHROUGH.** (1) Slice (b) first — mechanical replication of the shipped lane pattern across
the `Mat*Lit.wgsl` family + PBRSimple/PBRTextured; extend `probe-plain-hdr-tonemap.mjs` with a
MaterialAppearance-lit case (Δ vs WebGL per operator). (2) Slice (a): audit SkyAtmosphere/skybox/
stars/sun WGSL for inline gamma/tonemap under `useHDR`; align to the linear-out contract; the
oracle is the `probe-plain-hdr-gamma` mismatch dropping from ~11.96% toward the SDR control (~1.4%).

**TRAPS.** (1) SDR byte-identity is the hard off-gate for every hunk (spare-lane `> 0.5` branches,
0 at SDR). (2) The atmosphere path is shared with NS-SURFACE-SKYATMOSPHERE-NIGHT-BRIGHT and the
sun-blend divergence (atmosphere-sky cluster) — one concern: gamma/operator contract ONLY, no
brightness retunes. (3) `probe-hdr-pp-math` gate F runs against a known-stale pre-B506 baseline
(test-infra cluster row) — do not "fix" that baseline as a side effect; note it. (4) HDR forces
rgba16float — pipeline format generation guards exist (Q14) — don't add new format-baking caches
without the generation guard.

**VERIFICATION RECIPE.** `probe-plain-hdr-gamma.mjs` (globe residual ↓, SDR control unchanged),
`probe-plain-hdr-tonemap.mjs` extended (Mat-lit case per operator), `probe-hdr-toggle-invalidation.mjs`
green, collections/perinstance regression probes green.

**MODEL-TIER:** (b) **opus-or-sol** (pattern replication); (a) **fable** (operator-gap attribution
across the sky stack is diagnostic). **Effort M total.**

---

### B7. C6-SSGI-DIFFUSE follow-ups — P2, M (escalation-gated)

**WHAT + WHY.** `DEFERRED_WORK.md:13`. SSGI SHIPPED (SSILVB visibility-bitmask GI as
`algorithm:"ssgi"` on the AO stage; opt-in default-off; off-gate byte-identical; orbit no-op via
depth-sanitize + CPU altitude fade 8→60 km; `probe-ssgi.mjs` 6/6 GREEN). **DEFERRED-1 (quality):**
grazing-angle horizontal banding at low sliceCount (default **2** — verified at HEAD
`WebGPUPostProcessStageCollection.ts:728`) and/or exaggerated `giIntensity` (visible in
`probe-ssgi.mjs` at `giIntensity=8`; much subtler at default 1.0). **Escalate ONLY on probe
evidence** (the entry's own rule). Mitigation ladder (research §5): raise `sliceCount` → ensure TAA
integrates the frame-index slice rotation (already wired) → 2-iteration à-trous on
`BilateralBlur1D`. **DEFERRED-2:** GLSL ES 3.0 WebGL twin (C6-SSGI-DIFFUSE-GLSL, FI §D.7) —
feasible via `bitCount`, NOT parity-required (WebGPU-exceeds charter); schedule only on demand.

**WALKTHROUGH.** (1) Premise/probe evidence first: run `probe-ssgi.mjs` at HEAD; capture the
`giIntensity=8` near-horizontal leg and READ it — if banding is acceptable at default 1.0, record
and close DEFERRED-1 as not-escalated. (2) If escalating: implement the ladder in order, each with
before/after PNGs at BOTH default and exaggerated intensity; sliceCount raise must be measured
(GPU cost via `gpuPassCost`) and quality-gated, not free. (3) À-trous iteration is the last resort
(new pass = new cost — keep opt-in dial, default unchanged).

**TRAPS.** Off-gate byte-identity (default off) is inviolable; TAA-integration claims must be
tested with TAA actually enabled (TAA forces MSAA 1 — the probe leg must set it); do not conflate
with the AO (hbao/gtao) path — `probe-logdepth-pp-sliceb.mjs` guards it.

**VERIFICATION RECIPE.** `probe-ssgi.mjs` (6/6 stays green; banding leg quantified — propose adding
a horizontal-band FFT metric like A4's), `gpuPassCost` numbers recorded for any sliceCount change.

**MODEL-TIER: fable** (evidence-gated quality judgment). **Effort S evidence, M if ladder runs.**

---

### B8. NEW-PP-F16-DEVICE-VERIFY — P2, S — **environment-gated**

**WHAT + WHY.** `ROADMAP_AND_DEFERRED_WORK.md:735-736` + `:888/:1068`: the B478 opt-in f16 PP
variants (WGF-3: Tonemapping_f16 shipped; WGF-3-EXPAND pending for other stages) have **never had
an on-device pixel-verify on a `shader-f16`-capable (RTX-class) adapter** — the sandbox GPU can't
run it. Register: stranded P2 tooling.

**DISPOSITION.** This is a **maintainer-hardware task**: it cannot be completed by a sandboxed
worker. Deliverable shape when scheduled: a self-contained probe
(`probe-pp-f16-device-verify.mjs`) that (a) asserts `device.features.has("shader-f16")` and SKIPS
gracefully otherwise, (b) A/Bs f16-on vs f16-off per stage (Tonemapping today; extend as
WGF-3-EXPAND lands) with a per-operator tolerance band, (c) writes a machine-readable result the
ledger can cite. The worker authors + dry-runs the probe (skip path) in-sandbox; the maintainer runs
it once on RTX hardware and pastes the artifact. **Flag to orchestrator: needs a maintainer
execution step — schedule as a rider, not a blocking slice.**

**MODEL-TIER: opus** (probe authoring only). **Effort S.**

---

### B9. WGF-1-EXPAND — hardware clip-distances beyond globe — P2, M

**WHAT + WHY.** FI §C.7:852-853: WGF-1 SHIPPED-partial — the GLOBE path uses hardware
`clip-distances` (verified at HEAD: `clip_distances` in
`Shaders/WebGPU/chunks/structs/EffectsUniforms.wgsl`; consumer/wiring files
`WebGPUClipDistancePrecompute.ts`, `WebGPUGlobeSurfacePipelines.ts`, `WebGPUGlobeSurfaceShaders.ts`,
`WebGPUFeatureFlags.ts`, `WebGPUClippingPlaneCollection.ts` — 8 files). Remainder: **Primitive
shaders have the struct but no VS output; Models lack the hardware path entirely** — clipping
planes on those paths still cost per-fragment discard work.

**WALKTHROUGH.** (1) Premise-verify the feature-detect path (`clip-distances` is an OPTIONAL WebGPU
feature — `WebGPUFeatureFlags.ts` owns the gate; the fragment-discard path MUST remain as the
fallback for non-supporting adapters — never remove it). (2) Primitive family first (struct already
present): emit `@builtin(clip_distances)` from the VS where the feature bit is on, mirroring the
globe's precompute; pipeline-cache name gains the axis (name-axes rule). (3) Models: ModelPBR is at
tighter binding/varying budgets — check the interstage @location budget (the Q31 varyings item
documents 16/16 in the maximal case; clip_distances is a builtin, not a location, but the
enable-feature + struct plumb must thread WGSL codegen). (4) Perf claim optional: fragment-work
reduction is measurable via `gpuPassCost` on a heavy-clipped scene; promotion only via
moving-route rules if claimed.

**TRAPS.** Fallback preservation is charter-critical (feature-detect, graceful fallback). Clipping
correctness must hold for union mode only — INTERSECTION mode is B10's concern; do not entangle.
The clip-distance count limit (device `maxClipDistances` analog — WGSL allows up to 8) vs
collections with more planes → fallback to discard for overflow, exactly as the globe path decides.

**VERIFICATION RECIPE.** Propose `probe-clip-distance-primitive.mjs`: clipped box/ellipsoid
primitives + clipped model, hardware-on vs forced-fallback A/B byte-comparable (identical pixels,
different pipeline stats), plus a >8-planes overflow leg falling back cleanly.
`probe-clipping-planes-parity` (exists, noted as a standing model clip/pick probe) must stay at its
recorded state.

**MODEL-TIER: opus.** **Effort M.**

---

### B10. WGF-1-INTERSECTION — intersection-mode clipping — P2, M

**WHAT + WHY.** FI §C.7:854: `unionClippingRegions=false` semantics are unimplemented for the
hardware clip-distance path — intersected collections currently get **union behavior** on WebGPU's
hardware path (a silent semantics change for scenes using intersection mode). Register: WIP,
union-only.

**WALKTHROUGH.** (1) Premise-verify with a repro FIRST: intersection-mode clipping scene both
backends — confirm the wrong-region clip on the hardware path and the correct one on the discard
fallback (if the fallback also diverges, scope grows — file separately). (2) Semantics: union =
clipped when outside ANY plane (each plane one clip distance, min semantics); intersection =
clipped only when outside ALL planes — NOT expressible as independent per-plane hardware distances;
the standard mapping is a single computed distance = `max` over signed distances (fragment kept if
any plane keeps it) — i.e. intersection mode collapses to ONE synthesized clip distance in the VS
(interpolation caveat: max-of-planes is not linear — evaluate the interpolation error; where
non-linearity bites, the correct conservative answer is per-fragment discard, which is the
fallback). Decide hardware-eligibility per mode: it is legitimate to keep intersection mode on the
discard path PERMANENTLY if the linear-interpolation analysis fails — that is correctness-first,
documented, and cheap (intersection scenes are rare) — but it must be an explicit recorded decision,
not silence. (3) Route the mode bit through the same pipeline-name axis as B9.

**TRAPS.** The interpolation-correctness analysis is the actual work — a naive VS `max()` produces
curved-boundary artifacts on large triangles (globe tiles especially). Never ship "close enough"
clipping — clipping is a hard-edge correctness feature.

**VERIFICATION RECIPE.** Propose `probe-clip-intersection-mode.mjs`: union leg + intersection leg
per backend, edge-line ROI diff vs WebGL; fallback A/B.

**MODEL-TIER: fable** (the interpolation analysis + eligibility decision), opus for wiring.
**Effort M.**

---

### B11. WGF-4 + WGF-4-EXPAND — P3 dossier (standard-layout UBOs + RTE packer assertions)

FI §D.8:1030 (WGF-4 standard-layout UBOs, ~20% UBO size reduction across renderers) + §C.7:857
(WGF-4-EXPAND: RTE camera-packer assertions still pending in **5 of 8 packers** — Cloud / Ellipsoid /
Splat / PointCloud / Voxel). Two unrelated-but-bundled tails. The assertion half is the cheaper,
higher-value piece (precision guardrails on exactly the packers where an RTE regression would be
silent — and the Voxel packer is touched by A1/A2, the Splat packer by the splat-producer epic:
**opportunistic rider** — whichever slice touches a listed packer adds its assertion in the same
batch, debug-pragma'd per the logging rules). The UBO-layout half is a bandwidth micro-epic that
should wait for a measured driver (S6-3 uniform-ring fan-out in the terrain cluster is the adjacent
lever); do not open standalone without a moving-route hypothesis. **PREMISE-CHECK for a worker:**
re-grep which packers already carry assertions before adding (the 3-of-8 baseline may have moved).
**MODEL-TIER: opus riders, S each; UBO half unscheduled.**

### B12. C6-FSR2-UPSCALE — P3 gated-epic dossier (do not open as a task)

`DEFERRED_WORK.md:5223` — DEFERRED with premise verified REAL (no internal/output resolution split
exists anywhere; everything derives from `drawingBufferWidth/Height`) and a complete 4-phase plan
recorded (research `RESEARCH_R-FSR2_2026-07-06.md`, MIT license verified). Why it must stay a
dedicated multi-batch epic: (1) six dense GLSL→WGSL compute ports (~3–4k lines of temporal-resolve
math judged only by converged multi-frame probes); (2) WGSL has **no texture atomics** —
ReconstructPreviousDepth's `InterlockedMax` scatter must be re-architected as a reusable
`var<storage> array<atomic<u32>>` helper (a real artifact per the no-shortcuts rule); (3) a
17-subsystem internal-res/output-res split with a **silent pick-coordinate-scaling breakage risk**
(canvas-px→R-px in every pick readback). Phasing on record: P1 R/D split (`renderResolutionScale`,
byte-identical when off) → P2 `FSR2Prep.wgsl` (camera-motion MV synthesis + log-depth linearize) →
P3 pass ports + Quality 1.5× + SSIM probe (`probe-fsr2-upscale.mjs` — SSIM/mismatch vs native-res
WebGPU + `gpuPassCost`, NOT byte parity) → P4 reactive/presets/f16. Off-gate: `scene.fsr2Enabled`
default false ⇒ R==D ⇒ byte-identical; mutually exclusive with TAA+FXAA (one-time warn);
WebGPU-only under the Principle-5 compute exemption. **Orchestrator inputs:** needs a maintainer
GO to spend a multi-batch arc; sequencing AFTER the C10-13 reversed-Z GO/NO-GO is prudent (both
re-plumb depth consumers; doing FSR2's linearize against a depth contract that may flip is waste).
**MODEL-TIER when opened: opus per phase, fable for the P3 convergence-quality gates. Effort XL.**

---

## Cross-cluster sequencing (recommendation to the orchestrator)

1. **A1 (inside-camera P0)** opens immediately — self-contained, no C10 conflict.
2. **A4 premise-verify** and **A5 premise-verify** are cheap early wins (both may close rows).
3. **A3's `.vctr` fixture slice** unlocks A3+A8+the B178 verification debt — schedule early.
4. **B1 (effect-execution audit)** before B3 (its consumer inventory feeds the autoexposure gate)
   and before any Wave-3 visibility work elsewhere.
5. **B2 evidence slice** early (probe + parity-gap row + maintainer decision package); the wire
   waits for the ratification.
6. **B4 warn-slice** early; the selected-texture plumbing after C10-11's pick-fleet outcome is
   recorded.
7. **A7 waits** on the splat producer (cluster 3); **A9 waits** on nothing but should follow A6.
8. **B8** is a maintainer-hardware rider; **B11** rides other slices; **B12** stays gated.

## OPEN QUESTIONS for the orchestrator

1. **C10-11/C10-12 outcome dependency (pick + depth encode):** A4 (windowToEye consumer), A5
   (pick march), B4 (pick-id mask rasterization) all read surfaces the in-flight pick-fleet
   log-depth conversion may change. Their briefs need a "check C10 ledger at intake; re-anchor if
   C10-11 landed" preamble. Confirm at assembly whether C10-11 landed and in what form.
2. **Maintainer decisions needed:** (a) sunBloom parity direction — wire a WebGPU screen-space
   glare (default-pixel change, needs ratification) vs ratify the baked substitute (B2 step 3);
   (b) HDR autoexposure altitude-gate ratification (B3 — behavior kept, policy record missing);
   (c) intersection-mode hardware-eligibility if the interpolation analysis fails (B10);
   (d) ADR accumulation complete-vs-retire (A9 — retire needs explicit sign-off per Principle 7);
   (e) FSR2 multi-batch GO (B12).
3. **Register/docs corrections to fold into whatever lands first:** FEATURE_INVENTORY §C.5:822 and
   DEFAULT_PARITY_MATRIX row 7 still say `scene.pickVoxel` throws — resolved 2026-07-04/05 in code
   (verified at HEAD). The C11 register's C-R9 row should be re-pointed at the object-pick-footprint
   residual (A5).
4. **Cross-cluster dependency:** NEW-GS-CLASSIFICATION-DEPTH (A7) is blocked by
   NEW-WEBGPU-SPLAT-DATA-PRODUCER (splat cluster). If the splat producer is not scheduled in C11,
   A7 should be carried as a dossier row, not an open slice.
5. **Baseline hygiene:** B698 (model mip chain) and B693 (frustum collapse) changed default pixels/
   counters; several probes in this guide compare against stored baselines. Recommend a one-time
   supervised baseline recapture wave (blocked today by the standing spheres-drift rule —
   `--update` auto-blocked) or explicit per-probe fresh-capture instructions in every brief, as
   written here.
6. **Sub-gate red at clean HEAD:** `probe-voxel-megatexture.mjs` PART-3 `pixelsMatch` fails
   pre-existing (A2 slice 0 owns triage). Any voxel slice's verification battery must treat that
   ONE sub-gate as a known-red until triaged — confirm the orchestrator wants A2-slice-0 scheduled
   ahead of A1's battery to clean the signal.
7. **Effort/tier summary for assembly:** P0: A1 (M, fable-diagnose). P1: A2 (XL, sliced), A3 (L),
   A4 (M, fable), A5 (S, opus), A6 (M, fable-audit), B1 (M, fable), B2 (M, fable→opus). P2: A7
   (blocked), A8 (M), A9 (L, fable-design), A10 (M), B3 (S–M), B4 (M–L), B5 (M), B6 (M), B7
   (S–M, evidence-gated), B8 (S, maintainer-gated), B9 (M), B10 (M, fable-analysis). P3 dossiers:
   B11, B12.
