# Campaign 11 — Parity-Closure, Correctness-Reds, and Scale Architecture

Prepared: 2026-07-18

Status: **LAUNCHED / EXECUTING (2026-07-18).** Campaign 10 CLOSED at **Batch 711 (`9a52717cf2`)**; the
`C11-00B` launch-intake + fallout-sweep (§4) has RUN (this doc's 2026-07-18 reorder is its output) and
reconciled the tree. The standing maintainer directive for the C10→C11 seam is now exercised — the
loop is live and executing **W1** (which now opens with `C11-157` OIT translucent-primitive wiring; see
§5). The 2026-07-18 maintainer-ratified decisions are recorded RESOLVED in **§7.0**, the appended
schedulable rows in **§1.23** (`C11-157..165` + `C11-SEED-27`, collision-verified), and the new
`CELESTIAL_WATER_REFLECTION_RESEARCH.md` epic as **`C11-163`**. Historical launch-authority context is
preserved below.

Status (historical): **PREPARED / NOT LAUNCHED.** Auto-launches when Campaign 10 CLOSES, per the standing
maintainer directive (2026-07-17: "finish Campaign 9 and then move onto campaign 10" — the same
directive that armed C10 to launch on C9 close; C11 inherits the same standing-launch rule for the
C10→C11 seam). The `C11-00B` launch-intake sweep (§4) runs ONCE at that moment and reconciles the
tree before the first slice.

Launch authority: **standing directive**, exercised only after Campaign 10 reaches its close
(`C10-30` verdict recorded) and `C11-00B` has swept the live C10 ledger. No slice starts until the
launch note (§4 output) is presented to the maintainer with a `git branch -a` inventory and the tree
is clean (`npx tsc --noEmit` green).

Operating model: **ORCHESTRATOR** (the same model C10 launched under). The orchestrator (**Fable**,
the main loop) prepares each brief, dispatches a **model-matched worker** (**Opus** or **Sol**;
**Sol = external takeover** seat), reviews the returned diff adversarially, and **lands** it. Workers
implement on a **dirty tree and NEVER commit** (leave-dirty contract). The orchestrator is the only
actor that stages, commits, pushes, and flips ledger rows. Full charter + takeover manual + salvage
playbook + engine-script fallback: **`campaign11_planning/guides/G10-charter-mechanics.md`**
(authoritative for this queue's mechanics — this doc references it, does not duplicate it).

Source pointers:

- **Item universe (authoritative):** `campaign11_planning/CANDIDATE_REGISTER.md` — 188 merged items,
  22 clusters, 9 P0s. No existing IDs renamed; this queue assigns each a canonical `C11-xx` number
  (§1) and keeps every register name as an alias.
- **Cluster execution guides (per-item walkthroughs, anchors, model-tier, effort):**
  `campaign11_planning/guides/G1..G10`. A worker reads its task's guide section before implementing.
- **Cross-cutting planning findings:** `campaign11_planning/_PLANNING_STATUS.md`.
- **Structure mirrored:** `QUEUE_2026-07-16_CAMPAIGN10.md` (front matter + §1 rules + §2 rulings +
  §3 gates + §5 waves shape). Rules in §2 are inherited verbatim from Campaign-9/10 §1.
- **Defaults-parity feed:** `DEFAULT_PARITY_MATRIX_2026-07-18.md` (22 backend divergences → G8).
- **Anchors verified at HEAD `9204647535` (Batch 701)** (guides G1–G7 at `5b98ab9698`, G8/G9/G10 at
  `9204647535`); register sweep HEAD `aef553d592` (Batch 698); this queue assembled at HEAD
  `c643516c04` (Batch 703). **Line numbers are hints — re-grep every `file:symbol` before acting.**

---

## 1. CANONICAL ID TABLE (the campaign backbone — authored FIRST)

**Why this section is first (the C10 numbering-collision lesson, G10 §B8.6).** In C10 the register's
W8 rows were proposed as `C9-40…49`, collided with in-flight C9 rows, and had to be renumbered
`C10-01…10` ordinally. To prevent a repeat, **every schedulable register item is assigned its C11
number here, in one place, BEFORE any prose references it.** No `C11-xx` number is ever minted ad hoc
in wave/gate prose — prose points back to this table.

**Numbering scheme.**

- `C11-00` — engine-script fallback / launch infra (DEFERRED under orchestrator mode; absorbs the
  register's `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN` item).
- `C11-00B` — launch-intake sweep (name inherited from the `C10-00B` pattern; §4).
- `C11-01 … C11-156` — the **156 P0–P2 schedulable** register items, numbered in register-cluster
  order, **no gaps, no reuse**.
- `C11-GT-01 … C11-GT-03` — the 3 **gated-tail** items (cluster 19 `gated-reversed-z`); openable only
  by the gate chain in §6.
- `C11-SEED-01 … C11-SEED-26` — the 26 **P3 / arch-seed / next-campaign** items; recorded so the
  measured checkpoint can point at them, none C11-schedulable without its own gate.
- `C11-IC-01 … C11-IC-03` — the 3 **C10-owned intake-conditional** register items whose C11 status is
  decided by the live C10 ledger at `C11-00B` (they are NOT given a schedulable number until intake
  resolves them).
- `C11-GATE-D-CHECKPOINT` — the C11 measured performance checkpoint (a **gate row**, not a register
  item; §3 / §5 W8). Named to avoid colliding with `C11-30`.

**Placement accounting:** 156 numbered + 3 gated + 26 seeds + 3 intake-conditional = **188 register
items placed, zero unplaced.** Uniqueness verified mechanically (§1.24).

**Owning-guide caveat (a real finding, surfaced here):** two clusters — `rte-taa` (7 items,
`C11-51..57`) and `clouds-weather` (16 items, `C11-124..130` + `C11-SEED-10..18`) — have **no
dedicated cluster guide** (the 10 guides cover 165 of the 188 items; these 23 are guide-less). Their
rows carry owning guide `—`; a worker on any of them cuts against the register row + the source docs
directly, and the orchestrator should commission a rte-taa / clouds-weather guide before opening that
cluster's first non-trivial slice.

Columns: **C11-id · canonical register name(s) [aliases] · clusterKey · pri · workClass · effort ·
guide · wave.**

### 1.0 Infra / intake / gate rows

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-00` | Engine-script fallback prep [absorbs `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN`] | build-boot | R0 | infra | S | G10 | DEFERRED (orchestrator mode) |
| `C11-00B` | Launch-intake sweep [pattern of `C10-00B`] | — | R0 | gate | S | G10 | W0 |
| `C11-GATE-D-CHECKPOINT` | C11 default-path performance checkpoint [mirror of `C10-30`] | — | R0 | gate | M | G10/G9 | W8 |

### 1.1 `pick` (cluster 1, 11 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-01` | NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION | pick | P0 | correctness | unknown | G1 | W1 (diagnose) |
| `C11-02` | NEW-WEBGPU-BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY | pick | P0 | correctness | M | G1 | W2 |
| `C11-03` | NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT | pick | P0 | correctness | M | G1 | W2 |
| `C11-04` | NEW-WEBGPU-COMPUTE-INSTANCE-PICK-INDEX-MIRROR | pick | P0 | correctness | S–M | G1 | W2 |
| `C11-05` | NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY | pick | P1 | correctness | M | G1 | W2 |
| `C11-06` | C9-02A-WEBGPU-PICK-DEPTH-PLANE-PIPELINE-PARITY | pick | P1 | correctness | M | G1 | W2 (intake-cond. on C10-12) |
| `C11-07` | FAR-107-PICKQUERY-CONTRACT | pick | P1 | infra | M | G1 | W2 |
| `C11-08` | NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH / FAR-408-C0 | pick | P1 | perf | L | G1 | W2 |
| `C11-09` | NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (pick remainder) | pick | P1 | correctness | M | G1 | W2 |
| `C11-10` | BACKLOG-§4 Picking 6.1 main-scene depth blit | pick | P2 | parity | M | G1 | W2 |
| `C11-IC-01` | NEW-WEBGPU-PICK-FLEET-LOG-DEPTH ⚠C10 (C10-11 owns) | pick | P0 | correctness | XL | G1 | intake (§4) |

### 1.2 `standing-reds` (cluster 2, 15 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-11` | NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT | standing-reds | P0 | correctness | unknown–M | G1 | W1 (diagnose) |
| `C11-12` | NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION | standing-reds | P0 | correctness | M | G1 | W2 |
| `C11-13` | NEW-VOXEL-INSIDE-CAMERA-BLACK | standing-reds | P0 | correctness | M | G1 (walkthrough G6) | W1 |
| `C11-14` | NEW-WEBGL-ANISO-GLSL-BROKEN | standing-reds | P1 | correctness | S | G1 | W1 |
| `C11-15` | NEW-FEATURE-RENDERER-FAILED-STATE-RETRY | standing-reds | P1 | correctness | M | G1 | W1 |
| `C11-16` | NEW-WEBGPU-POINT-BLENDOPTION-SYNC | standing-reds | P1 | correctness | M | G1 | W1 (cheap rider) |
| `C11-17` | NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-PARITY | standing-reds | P1 | parity | S | G1 | W1 (cheap rider) · **RATIFIED 2026-07-18: FIX (§7.0)** |
| `C11-18` | NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME | standing-reds | P1 | correctness | S | G1 | W7 (blocked on C11-26 producer) |
| `C11-19` | BUG-GLOBE-PIPELINE-NAME-AXES | standing-reds | P1 | correctness | S | G1 | W1 |
| `C11-20` | C-R12-PER-OBJECT-CACHES | standing-reds | P1 | correctness | S | G1 | W3 |
| `C11-21` | BACKLOG-§Material UBO field-name alignment audit | standing-reds | P1 | correctness | M | G1 | W3 |
| `C11-22` | NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY | standing-reds | P2 | parity | S | G1 | W1 (cheap rider) |
| `C11-23` | NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING | standing-reds | P2 | correctness | M | G1 | W7 (FAR-003 lane) |
| `C11-24` | NEW-WEBGPU-RENDERCOMMAND-STALE-PASS-SLOT | standing-reds | P2 | correctness | S | G1 | W1 |
| `C11-25` | OPEN-1-DIAGNOSE (sky-atmosphere compile) | standing-reds | P2 | correctness | unknown | G1 | W1 (verify-then-close) |

### 1.3 `splat` (cluster 3, 2 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-26` | NEW-WEBGPU-SPLAT-DATA-PRODUCER | splat | P1 | feature | L | G5 | W7 · **BLOCKED-ON-MAINTAINER** |
| `C11-IC-02` | C10-04-SPLAT-ASYNC-SORT ⚠C10 | splat | P2 | perf | M | G5 | intake (§4); blocked on C11-26 |

### 1.4 `model-frontend` (cluster 4, 5 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-27` | C9-17-MODEL-SETTLED-FRONTEND-REVISIONS Slice D | model-frontend | P1 | perf | L | G4 | W6 (STOP-gated on checkpoint attribution) |
| `C11-28` | S9-2 — effects bind-group memoization | model-frontend | P1 | perf | S | G4 | W3 |
| `C11-29` | S9-3 — retained-command executor unification | model-frontend | P2 | perf | L | G4 | W6 (after C11-27) |
| `C11-30` | S9-4 — GPU-cull feed pooling | model-frontend | P2 | perf | S | G4 | W3 |
| `C11-31` | S11-1 remainder — WebGPUModelFeatureId batch-texture force-create | model-frontend | P2 | perf | S–M | G4 | W3 (after C10-02) |

### 1.5 `terrain-imagery` (cluster 5, 11 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-32` | C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT / FAR-303 | terrain-imagery | P1 | perf | XL | G2 | W6 (dedicated multi-batch family) |
| `C11-33` | C9-11-RETAINED-TERRAIN-DESCRIPTORS / FAR-309 (remainder) | terrain-imagery | P1 | perf | L–XL | G2 | W6 (C11-32 prereq) |
| `C11-34` | C9-15-TERRAIN-GPU-RESIDENCY-BUDGET / FAR-203 / FAR-208 | terrain-imagery | P1 | perf | L | G2 | W3 |
| `C11-35` | NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD | terrain-imagery | P1 | perf | S–M | G2 | W1 (cheap rider) |
| `C11-36` | C-R1-GLOBE-RENDERSTATE | terrain-imagery | P1 | correctness | M | G2 | W3 |
| `C11-37` | S1-1 — WebGL-lane globe derived-command regen | terrain-imagery | P2 | perf | M | G2 | W3 (after C11-33) |
| `C11-38` | S6-3 — uniform-ring fan-out beyond terrain | terrain-imagery | P2 | perf | M | G2 | W6 (with C11-32 family) |
| `C11-39` | S5-4 — per-tile worker-computable scans | terrain-imagery | P2 | perf | S | G2 | W3 |
| `C11-40` | S3-3 — GlobeTerrain debug-sentinel stripping | terrain-imagery | P2 | perf | S | G2 | W3 |
| `C11-41` | Streamed-imagery never-shared prompt-retire verification lane (B686 F2a) | terrain-imagery | P2 | tooling | S–M | G2 | W1 |
| `C11-42` | DP-H19-SHADER-DECODE-RUNTIME | terrain-imagery | P2 | perf | M | G2 | W3 |

### 1.6 `attachment-topology` (cluster 6, 8 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-43` | C9-10-CONSUMER-DRIVEN-MRT / FAR-403-C0 | attachment-topology | P1 | perf | XL | G3 | W6 (P0 key-audit prereq) |
| `C11-44` | S4-2 / S4-3 / S4-4 — C9-35 MSAA containment remainder | attachment-topology | P1 | perf | M | G3 | W3 |
| `C11-45` | S7-2 — per-frustum fixed pass scaffold gating | attachment-topology | P1 | perf | M | G3 | W3 |
| `C11-46` | S2-5 — pass-reopen descriptor caching | attachment-topology | P2 | perf | S | G3 | W3 |
| `C11-47` | S7-5 — multi-frustum contract machinery | attachment-topology | P2 | perf | S | G3 | W3 |
| `C11-48` | Seed-10 cleanup wave — S6-6 / S6-4 / S4-6 / S4-7 | attachment-topology | P2 | perf (+2 bugs) | M | G3 | W3 |
| `C11-49` | Phase-8a / FEAT-GAP-01 — normal G-buffer + depth prepass | attachment-topology | P2 | infra | XL | G3 | W7 (maintainer-scoping gate) |
| `C11-50` | Phase-8a normal-G-buffer validation probe | attachment-topology | P2 | tooling | S | G3 | W3 (must precede C11-43 flip & C11-49) |

### 1.7 `rte-taa` (cluster 7, 7 items — NO dedicated cluster guide)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-51` | NEW-TAA-CUSTOM-FRUSTUM-JITTER-FALLBACK | rte-taa | P0 | correctness | S | — | W1 (crash-class) |
| `C11-52` | C9-24-RTE-PRODUCER-CONSUMER-INVENTORY / FAR-305 | rte-taa | P1 | correctness | M | — | W5 (R0 foundation) |
| `C11-53` | C9-25-PREVIOUS-FRAME-RTE / FAR-306 | rte-taa | P1 | correctness | L | — | W5 (dep C11-52) |
| `C11-54` | C9-26-GPU-VISIBILITY-RTE-CLOSURE | rte-taa | P1 | correctness | L | — | W5 |
| `C11-55` | NEW-TAA-MULTIFRUSTUM-DEPTH-REPROJECTION-CONTRACT / C9-29 | rte-taa | P1 | correctness | L | — | W5 |
| `C11-56` | TAA-DESIGN Slices 2b+3 | rte-taa | P2 | parity | L | — | W5 |
| `C11-57` | TAA-DESIGN Slice 4 | rte-taa | P2 | correctness | L | — | W5 (dep C11-56) |

### 1.8 `frame-delta` (cluster 8, 7 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-58` | S1-3 — globe-height plumbing rebuild | frame-delta | P1 | perf | M | G4 | W3 |
| `C11-59` | S1-5 / S7-6 — 2D/CV/ortho band economics | frame-delta | P2 | perf | M | G4 | W3 |
| `C11-60` | S2-2 / S2-3 / S2-4 — cache-hit-path allocation riders | frame-delta | P2 | perf | S | G4 | W3 |
| `C11-61` | NEW-CLUSTERED-ENABLED-ZERO-LIGHT-FRAME-ZERO-WORK | frame-delta | P2 | perf | S | G4 | W3 |
| `C11-62` | C9-08 octree persistence / NEW-SCENEOCTREE-DIRTY-REVISION-REBUILD-AND-PVS-PROMOTION | frame-delta | P2 | perf | M | G4 | W3 |
| `C11-63` | C10-10 follow-up — revision-maintained shadow-caster sublist | frame-delta | P2 | perf | M | G4 | W6 (blocked on S1-6 tier `C11-SEED-23`) |
| `C11-SEED-01` | WebGL near-ground seg5 p99 GC-tail (no ID) | frame-delta | P3 | perf | unknown | G4 | seed |

### 1.9 `entity-scale` (cluster 9, 12 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-SEED-02` | Entity-at-scale arc (S10 umbrella) | entity-scale | P1 | perf | XL | G7 | seed (arc; members below) |
| `C11-64` | 10k-entity benchmark lane (§14 seed 3 prerequisite) | entity-scale | P1 | tooling | S | G7 | W7 (FIRST in the S10 arc) |
| `C11-65` | S10-1 — dynamic-entity fallback lane (supersedes S1-4) | entity-scale | P1 | perf | L | G7 | W7 (dep C11-64) |
| `C11-66` | S10-2 / S10-3 — clustering forfeits bulk lane + declutter rebuild | entity-scale | P1 | perf | L | G7 | W7 (dep C11-64) |
| `C11-67` | S10-4 — GeometryUpdaterSet lazy instantiation | entity-scale | P2 | perf | M | G7 | W7 |
| `C11-68` | S10-5 — collection define-scan gating | entity-scale | P2 | perf | S | G7 | W7 |
| `C11-69` | S10-6 — pick instance repack + visibility-flip structural rebuild | entity-scale | P2 | perf | M | G7 | W7 (after FAR-107 `C11-07`) |
| `C11-70` | S10-7 / S10-8 — geometry/path incremental batching | entity-scale | P2 | perf | L | G7 | W7 |
| `C11-71` | S10-9 — ModelVisualizer static lane | entity-scale | P2 | perf | S | G7 | W7 |
| `C11-72` | S2-1 — collection resolver-closure churn | entity-scale | P2 | perf | S | G7 | W3 (scope vs C9-27) |
| `C11-73` | FAR-307-POLYLINE-PERSISTENT-MATERIAL-TABLE | entity-scale | P2 | perf | L | G7 | W7 |
| `C11-74` | PARITY-POINT-SPRITE-SHAPE-RESIDUALS | entity-scale | P2 | parity | M | G7 | W7 |

### 1.10 `submit-residency` (cluster 10, 4 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-75` | FAR-200-S1-PHYSICAL-QUEUE-TIMELINE | submit-residency | P1 | infra | M | G2 | W3 (sanctioned pre-Gate-B shadow) |
| `C11-76` | FAR-200 private-submit-timeline consolidation [PR S6-7/S6-5] | submit-residency | P1 | infra/perf | M–L | G2 | W3 (moves BEFORE C11-75 authority) |
| `C11-77` | Geometry-residency dedupe [PR S11-3; arch-seed A7] | submit-residency | P1 | perf | L | G2/G10 | W6 (gated on typedArray-release policy) |
| `C11-78` | NEW-PICK-ID-OWNERSHIP-MODEL | submit-residency | P2 | perf | M | G2 | W2 (pick family) |

### 1.11 `celestial-env` (cluster 11, 2 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-79` | NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES | celestial-env | P1 | perf | S–M | G7 | W1 (cheap rider) |
| `C11-80` | NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION | celestial-env | P1 | correctness | M | G7 | W1 (instrument first; C11-80 before C11-79 retains star cmds) |

### 1.12 `tiles-model-parity` (cluster 12, 21 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-81` | TILE-ARCH-SHADER-STRATEGY | tiles-model-parity | P1 | parity | L | G5 | W4 (define-width dependent) |
| `C11-82` | C-R1-TILE-BATCH | tiles-model-parity | P1 | parity | M | G5 | W7 |
| `C11-83` | WIRE-MODEL-COLOR-ALPHA-SEMANTICS | tiles-model-parity | P1 | parity | M | G5 | W7 |
| `C11-84` | FEAT-3DT2-02 — property-texture/feature-ID WGSL sampling audit | tiles-model-parity | P2 | parity | M | G5 | W7 |
| `C11-85` | FEAT-3DT2-05 — Draco/KTX2/meshopt end-to-end audit | tiles-model-parity | P2 | parity/tooling | M | G5 | W7 |
| `C11-86` | FEAT-3DT2-01 — styling expression → WGSL compiler | tiles-model-parity | P2 | parity/perf | L | G5 | W7 |
| `C11-87` | Phase-8a Tile↔Hi-Z wiring | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-88` | KHR_materials_variants / IOR / clearcoat-IOR coupling | tiles-model-parity | P2 | parity | M | G5 | W7 (after C10-08) |
| `C11-89` | 5 default textures bound per model draw | tiles-model-parity | P2 | perf | S | G5 | W4 (after C10-08 axes) |
| `C11-90` | GLTF-POINTS-MODE-RESIDUALS | tiles-model-parity | P2 | parity | M | G5 | W7 |
| `C11-91` | WIRE-MODEL-SILHOUETTE-TRANSLUCENT-DIVERGENCE | tiles-model-parity | P2 | parity | S–M | G5 | **RESOLVED-direction 2026-07-18 (replicate WebGL body-wash); re-scoped 2026-07-19 → `C11-157` Slice D.** Model OIT reachability (C11-157 Slice C) LANDED, but the silhouette body-wash is design-heavy (its own stencil/pass machinery, NOT a ride-along) — DEFERRED as Slice D with a recommended approach recorded in `DEFERRED_WORK.md` (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` → Slice D). The Slice-C `getOITColorConfig` machinery is ready for it. |
| `C11-92` | NEW-MODEL-WGSL-CUSTOM-SHADER (Q31 Slice C varyings) | tiles-model-parity | P2 | parity | L | G5 | W4 (blocked on `C11-149` define-width) |
| `C11-93` | NEW-MODEL-SCENE2D-IDL-DUPLICATE | tiles-model-parity | P2 | parity | M | G5 | W7 |
| `C11-94` | BACKLOG-§4.6 — indirect drawing for 3D Tiles | tiles-model-parity | P2 | perf | L | G5 | W7 (after C11-27/C11-29) |
| `C11-95` | R-7a — render-bundle expansion to 3D Tiles opaque models | tiles-model-parity | P2 | perf | M | G5 | W7 (behind C11-27/C11-29) |
| `C11-96` | TILE-PERF-02 — KTX2 transcode on a worker | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-97` | TILE-WASM-01 — WASM SIMD tile traversal | tiles-model-parity | P2 | perf | L | G5 | W7 |
| `C11-98` | FORK-41 — PointCloudSort + GPUSortKeys consumers | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-99` | FEAT-SURVEY-06 — decoupled-lookback prefix-sum consumers | tiles-model-parity | P2 | perf | M | G5 | W7 |
| `C11-SEED-03` | Phase-8b TileStoreGPU | tiles-model-parity | P3 | perf | XL | G5 | seed |
| `C11-SEED-04` | BACKLOG-§8 GPUExternalTexture | tiles-model-parity | P3 | perf | M | G5 | seed |

### 1.13 `classification-voxel` (cluster 13, 9 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-100` | PARITY-VOXEL-OCTREE-TRAVERSAL | classification-voxel | P1 | parity | XL | G6 | W7 (sliced; A2-slice-0 triage first) |
| `C11-101` | NEW-CLASSIFIER-2D-CV-MORPH | classification-voxel | P1 | parity | L | G6 | W7 (.vctr fixture prereq) |
| `C11-102` | NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION | classification-voxel | P1 | correctness | M (maybe S) | G6 | W7 (re-verify first) |
| `C11-103` | C-R9-VOXEL-CELL-PICK-TAIL | classification-voxel | P1 | parity | S | G6 | W7 (premise-stale: re-scope) |
| `C11-104` | C-R1-CLASSIFICATION | classification-voxel | P1 | parity | M | G6 | W7 |
| `C11-105` | NEW-GS-CLASSIFICATION-DEPTH | classification-voxel | P2 | parity | M | G6 | W7 (blocked on C11-26 producer) |
| `C11-106` | C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES | classification-voxel | P2 | parity | M | G6 | W7 |
| `C11-107` | ADR-2026-04-28 (incl. C-R8-TRANSLUCENT-MULTI-FRUSTUM) | classification-voxel | P2 | infra | L | G6 | W7 (after C11-104) |
| `C11-108` | VOXEL-USER-CUSTOMSHADER-RESIDUALS | classification-voxel | P2 | parity | M | G6 | W7 |

### 1.14 `shadows-lighting` (cluster 14, 5 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-109` | SHADOW-LAYOUT-QUANTIZED | shadows-lighting | P1 | correctness | S | G8 | W1 (premise-reconcile; likely doc-close) |
| `C11-110` | CSM-DESIGN Slices 3-4 | shadows-lighting | P2 | parity | L | G8 | W7 |
| `C11-111` | C-R10-GLOBE-POINT-LIGHT | shadows-lighting | P2 | parity | M | G8 | W7 (premise-reconciled W1) |
| `C11-112` | C6-LTC-AREA-LIGHTS follow-ups | shadows-lighting | P2 | feature | M | G8 | W7 |
| `C11-SEED-05` | FEAT-GAP-06 — bent-normal AO (terrain) | shadows-lighting | P3 | feature | M | G8 | seed (behind FEAT-GAP-01) |

### 1.15 `atmosphere-sky` (cluster 15, 6 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-113` | C9-14B-ATMOSPHERE-LUT-CONSUMPTION | atmosphere-sky | P1 | perf | M | G8 | W7 (gated on checkpoint attribution; premise-reconciled W1) |
| `C11-114` | C6-HIGHER-ORDER-SCATTER-LUT (reframed diagnostic) | atmosphere-sky | P2 | correctness | S | G8 | W7 |
| `C11-115` | NS-SUN-BLEND-MODE-DIVERGENCE | atmosphere-sky | P2 | parity | M | G8 | W7 · **RESOLVED 2026-07-18: WebGPU ALPHA_BLEND (match WebGL) (§7.0)** |
| `C11-116` | NS-SURFACE-SKYATMOSPHERE-NIGHT-BRIGHT | atmosphere-sky | P2 | parity | unknown | G8 | W7 |
| `C11-SEED-06` | FUT-MULTI-BODY-ATMOSPHERE | atmosphere-sky | P3 | feature | M–L | G8 | seed |
| `C11-SEED-07` | NEW-SUN-MOON-FIDELITY | atmosphere-sky | P3 | feature | M | G8 | seed |

### 1.16 `postprocess-effects` (cluster 16, 9 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-117` | C9-23-EFFECT-EXECUTION-AUDIT / FAR-500-C0 | postprocess-effects | P1 | correctness | M | G6 | W7 (Wave-3 visibility gateway; open first in cluster) |
| `C11-118` | WIRE-PP-LIBRARY-BUILTINS-RESIDUALS | postprocess-effects | P2 | parity | M | G6 | W7 |
| `C11-119` | NEW-PLAIN-HDR-SCENE-GAMMA-EPIC residual | postprocess-effects | P2 | parity | M | G6 | W7 |
| `C11-120` | C6-SSGI-DIFFUSE follow-ups | postprocess-effects | P2 | feature | M | G6 | W7 |
| `C11-121` | NEW-PP-F16-DEVICE-VERIFY | postprocess-effects | P2 | tooling | S | G6 | W7 (physical adapter; ties to C11-135) |
| `C11-122` | WGF-1-EXPAND — hardware clip-distances beyond globe | postprocess-effects | P2 | perf | M | G6 | W7 |
| `C11-123` | WGF-1-INTERSECTION — intersection-mode clipping | postprocess-effects | P2 | parity | M | G6 | W7 |
| `C11-SEED-08` | WGF-4 (+WGF-4-EXPAND) — standard-layout UBOs + RTE packer assertions | postprocess-effects | P3 | perf | M | G6 | seed |
| `C11-SEED-09` | C6-FSR2-UPSCALE | postprocess-effects | P3 | perf | XL | G6 | seed · maintainer GO |

### 1.17 `clouds-weather` (cluster 17, 16 items — NO dedicated cluster guide)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-124` | C7-CLOUD-LIGHTNING (reland = C9 W7-1) | clouds-weather | P2 | feature | M | — | W7 |
| `C11-125` | C6-CLOUD-STBN-TAAU | clouds-weather | P2 | feature | M | — | W7 (needs offline EA-SEED STBN) |
| `C11-126` | CLOUD-U4-REMOVE-GLOBE-FLAG | clouds-weather | P2 | infra | L | — | W7 · **RESOLVED 2026-07-18: option (A) — Scene owns a managed default VOLUMETRIC CloudCollection (§7.0)** |
| `C11-127` | Q36-WEATHER-PHASE-4-GRIB2 | clouds-weather | P2 | feature | L | — | W7 (proxy prereq; env-blocked) |
| `C11-128` | Live EDR network confirm | clouds-weather | P2 | tooling | S | — | W7 (needs networked session) |
| `C11-129` | WeatherSystem / scene.weather facade (Phase 3) | clouds-weather | P2 | feature | M | — | W7 |
| `C11-130` | PRECIP-DATA ground snow-albedo shader consumer | clouds-weather | P2 | feature | S | — | W7 |
| `C11-SEED-10` | C7-CLOUD-IMPOSTOR-LOD | clouds-weather | P3 | perf | L | — | seed (dep CLOUD-U4) |
| `C11-SEED-11` | CLOUD-LOD-R8-PRECIPITATION-COUPLING | clouds-weather | P3 | feature | L | — | seed |
| `C11-SEED-12` | CLOUD-LOD-R9-PLANET-SCALE-CLOUD-TILING | clouds-weather | P3 | feature | XL | — | seed |
| `C11-SEED-13` | CLOUD-EXOTIC-E3-SPECIAL remainder | clouds-weather | P3 | feature | L | — | seed |
| `C11-SEED-14` | Cloud perf — Tier-2 3D bake (view-local cascaded clipmap) | clouds-weather | P3 | perf | XL | — | seed |
| `C11-SEED-15` | Temporal interpolation + advection (Phase 5) | clouds-weather | P3 | feature | M | — | seed |
| `C11-SEED-16` | Historical-replay headline demo (Phase 4) | clouds-weather | P3 | feature | M | — | seed (gated on C11-127) |
| `C11-SEED-17` | profileExtinction (slot 103) per-position optical extinction | clouds-weather | P3 | feature | M | — | seed |
| `C11-SEED-18` | NEW-CLOUD-SHADOW-ENVMAP | clouds-weather | P3 | feature | S | — | seed |

### 1.18 `water` (cluster 18, 2 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-131` | C6-PLANAR-REFLECT-REFRACT | water | P2 | feature | L | G8 | W7 (after C10-08b/reversed-Z disposition) |
| `C11-SEED-19` | WATER-PHASES-1-9 (Gerstner/bathymetry/foam/rivers/underwater/WaterRegion) | water | P3 | feature | XL | G8 | seed |

### 1.19 `gated-reversed-z` (cluster 19, 3 items — gated tail, §6)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-GT-01` | C10-13-REVERSED-Z-EARLYZ-SPIKE ⚠C10 | gated-reversed-z | P1 | perf/tooling | S | G10 | **W1 (measurement-only spike, ratified 2026-07-18)** / GT for the slice (§6) |
| `C11-GT-02` | C10-GT-REVERSED-Z-SLICE-B ⚠C10 | gated-reversed-z | P2 | perf | XL | G10 | GT (do not schedule) |
| `C11-GT-03` | C10-03R-MSAA-DEFAULT-FLIP-RESERVE ⚠C10 | gated-reversed-z | P3 | perf | S | G10 | GT (reserve lever) |

### 1.20 `test-infra` (cluster 20, 16 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-132` | NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS (item 4A / A.2) | test-infra | P1 | tooling | S | G9 | W1 (environment prereq) |
| `C11-133` | Karma headless-Edge launcher environmental flakiness (A.1) | test-infra | P1 | tooling | unknown | G9 | W1 (environment prereq) |
| `C11-134` | NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION (A.3) | test-infra | P1 | tooling | M | G9 | W1 (environment prereq) |
| `C11-135` | C9-04-PHYSICAL-ADAPTER-CONTRACT-MATRIX (A.4) | test-infra | P1 | tooling | L | G9 | W7 (after C11-133) |
| `C11-136` | NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE (item 64 / A.5) | test-infra | P1 | correctness | L | G9 | W7 (exit-gate owner) |
| `C11-137` | C8-SHARED-UPSTREAM-CONTRACT-GATE (item 72 / A.16) | test-infra | P1 | infra/tooling | L | G9 | **EXIT (dead last)** |
| `C11-138` | NEW-SHADER-GENERATOR-UPSTREAM-CONTRACT-PARITY (item 66 / A.6) | test-infra | P1 | correctness | S | G9 | W7 (exit-gate owner; cheapest) |
| `C11-139` | C9-03-CERTIFYING-VISUAL-BASELINE-PROMOTION | test-infra | P1 | tooling | M | G9 | W7 (after C11-11 spheres repaired) |
| `C11-140` | NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING (A.11) | test-infra | P1 | tooling | S | G9 | W1 (perf-claim prereq tooling) |
| `C11-141` | C9-02-VISIBILITY-EXECUTION-OWNERSHIP-MANIFEST | test-infra | P1 | correctness | L | G9 | W7 |
| `C11-142` | NEW-RESOURCE-URL-SEMANTIC-PARITY (item 67 / A.7) | test-infra | P2 | correctness | L | G9 | W7 (exit-gate owner) |
| `C11-143` | NEW-ENTITY-BULK-CLUSTER-TRANSITION-PARITY (item 69 / A.8) | test-infra | P2 | correctness | M | G9 | W7 (exit-gate owner) |
| `C11-144` | NEW-KMZ-ARCHIVE-URI-RESOLUTION-PARITY (item 70 / A.9) | test-infra | P2 | correctness | L | G9 | W7 (exit-gate owner; after C11-133) |
| `C11-145` | C9-01-REGRESSION-ATTRIBUTION remainder (Gate-A closure) | test-infra | P2 | tooling | S | G9 | W7 · maintainer amendment |
| `C11-146` | S8-7 — settle-window attribution rule + first-complete-frame metric (A.14) | test-infra | P2 | tooling | S | G9 | W1 (perf-claim prereq tooling) |
| `C11-147` | probe-hdr-pp-math gate F baseline refresh (A.15) | test-infra | P2 | tooling | S | G9 | W7 (after globe/HDR pixels settle) |

### 1.21 `build-boot` (cluster 21, 13 items)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-148` | NEW-MATERIAL-PER-BACKEND-SHADER-SOURCE | build-boot | P1 | infra | M | G9 | W4 |
| `C11-149` | C10-08b — ShaderDefine define-width expansion ⚠C10 (follows C10-08) | build-boot | P1 | infra | M | G9 | **W1 (early — C10-08 landed at C10 close, unblocks `C11-158` enhanced-ocean toggle)** · **HARD PREREQ for any new define bit** |
| `C11-150` | S8-5 / S3-7 — WGSL module granularity + globe imagery layout tranches | build-boot | P2 | perf | L | G9 | W4 (after C10-07) |
| `C11-151` | NEW-WGSL-STRING-COMMENT-STRIP | build-boot | P2 | perf | S | G9 | W4 |
| `C11-152` | NEW-EMPTYMODULE-STUB-HARDENING | build-boot | P2 | infra | S | G9 | W4 (prereq for leaf-strip seed) |
| `C11-153` | S8-4 — feature-renderer registration lazify ⚠C10-06 rider | build-boot | P2 | perf | S | G9 | W4 (intake-cond. on C10-06) |
| `C11-154` | NEW-TS-CONVERT-JS-RENDERERS | build-boot | P2 | infra | XL | G9 | W4+ (one renderer/batch; WebGPUModelRenderer already .ts — strike) |
| `C11-155` | Q35-WEBGPUCONTEXT-DECOMP-REMAINDER | build-boot | P2 | infra | M | G9 | W4 |
| `C11-156` | BACKLOG-§Recent — WebGPUComputePipelineCache (re-scope: cache EXISTS → route consumers) | build-boot | P2 | perf | S | G9 | W1 (premise-reconcile) / W3 (route) |
| `C11-SEED-20` | NEW-WEBGPUONLY-RENDERER-LEAF-STRIP | build-boot | P3 | infra | S | G9 | seed (dep C11-152) |
| `C11-SEED-21` | NEW-C9-01-COUNTER-PRAGMA-STRIP | build-boot | P3 | tooling | S | G9 | seed |
| `C11-SEED-22` | C6-SUBGROUP-COMPUTE-FINISH | build-boot | P3 | perf | S | G9 | seed (needs sort consumers) |
| `C11-IC-03` | C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN ⚠C10 | build-boot | P3 | infra | S | G10 | intake → folds into `C11-00` |

### 1.22 `arch-seeds` (cluster 22, 4 items — all next-campaign seeds)

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-SEED-23` | S1-6 — frame-delta retained-commandList tier | arch-seeds | P1 | perf | XL | G10/G4 | seed (unblocks C11-63, S1-1) |
| `C11-SEED-24` | Worker-renderer productization [PR S5-3] | arch-seeds | P2 | infra | XL | G10 | seed (benchmark lane first) |
| `C11-SEED-25` | S5-2 — WASM acceleration layer consume-or-retire | arch-seeds | P2 | perf | M | G10 | seed (per-bridge disposition) |
| `C11-SEED-26` | NEW-VEGETATION-SYSTEM | arch-seeds | P3 | feature | XL | G10 | seed |

### 1.23 Campaign-11 launch-reorder appends (2026-07-18, `C11-00B` sweep — APPEND-ONLY, collision-verified)

Minted by the `C11-00B` fallout-intake + launch-reorder sweep (2026-07-18). **Append-only additions**
starting at `C11-157` (the numbered range `C11-01..156` was NOT renumbered or reused; `C11-SEED-27`
follows `C11-SEED-26`). Every ID below was checked against §1.0–§1.22 and the GT/SEED/IC suffix ranges —
**no collision** (§1.24 addendum). Items that ALREADY carry a register number are NOT re-minted here;
their ratified direction is recorded IN PLACE — background-color `C11-17`, silhouette body-wash `C11-91`,
sun-blend `C11-115` (see §7.0). Every alias below is preserved verbatim from its DEFERRED_WORK / matrix
row (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` + `NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-
CENTRALIZATION` are pre-filed DEFERRED_WORK entries dated 2026-07-18 that were awaiting a C11 number).

| C11-id | Canonical name / aliases | cluster | pri | workClass | effort | guide | wave |
|---|---|---|---|---|---|---|---|
| `C11-157` | NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING [Batch-700 fallout; FULL primitive→collection→model; **absorbs the `C11-91` silhouette body-wash resolution**] | standing-reds (FAR-003 OIT lane) | P1 | feature/correctness | L–XL | G1/G3 | **W1 (TOP)** |
| `C11-158` | NEW-WEBGPU-ENHANCED-OCEAN-DEFAULT-PARITY-TOGGLE [defaults-parity D1; `ENHANCED_OCEAN` define-gate; default classic water, enhancement opt-in] | water | P1 | parity/infra | M–L | G8 | W4 (**HARD PRED `C11-149`**; land with `water-bugs-2026-07-06`) |
| `C11-159` | NEW-WEBGPU-NIGHTLIGHTS-DEFAULT-OFF-PARITY [matrix row 17; default OFF, keep opt-in toggle] | atmosphere-sky | P2 | parity | S | G8 | W1 (cheap rider) |
| `C11-160` | NEW-WEBGPU-SUNBLOOM-PP-WIRING [matrix row 3; wire `scene.sunBloom` → WebGPU PP Bloom/LensFlare] | postprocess-effects | P2 | parity | M | G6/G8 | W7 (after `C11-117`; mid-campaign intent) |
| `C11-161` | NEW-WEBGPU-AUTOEXPOSURE-DEMAND-GATE [matrix row 14; demand-gate the dispatch + ratify HDR altitude-gate] | postprocess-effects | P2 | perf/parity | S | G6/G8 | W7 (after `C11-117` consumer inventory) |
| `C11-162` | NEW-WEBGPU-USEPOSTPROCESSSELECTED-PORT [matrix row 19; port the selected-feature path] | postprocess-effects | P2 | correctness | M | G6 | W7 |
| `C11-163` | C11-CELESTIAL-WATER-REFLECTION [unified sun-by-day + moon/stars-by-night reflection on water + clouds; runtime UBO enable-float — **NO new define bit, NO `C11-149` dep**; cheap path does NOT touch depth (**NOT reversed-Z-coupled**); S0 day-sun-glint audit/unify front-of-line] | water (celestial-water lane) | P2 | feature | L–XL | G8 + `CELESTIAL_WATER_REFLECTION_RESEARCH.md` | **Tier-4 / gated** (opt-in default-OFF, byte-identical off) |
| `C11-164` | NEW-WEBGPU-PICK-COLD-SYNC-STALENESS [C10-11 fallout — **cold-page async-pick-readback RACE**; reopens the June-361 docs-only close, distinct live-race defect] | pick | P1 | correctness | M | G1 | W2 (pick fleet) |
| `C11-165` | NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-CENTRALIZATION [C10-07 follow-on; pre-filed DEFERRED_WORK 2026-07-18] | build-boot | P2 | infra | M | G9 | W4 (boot chain) |
| `C11-SEED-27` | C10-30 clean-environment r5 re-measure (Gate-D reference — C10-30 wall-clock was env-confounded at close; deterministic **−33% render-passes/frame** recorded, no banner) | — | R0 | tooling/measurement | S | G10/G9 | seed (Gate-D anchor input) |

**Append accounting:** +9 numbered (`C11-157..165`) + 1 seed (`C11-SEED-27`) = **10 new rows**, all
collision-free. Three ratified directions land on EXISTING rows (no new ID): `C11-17`, `C11-91`,
`C11-115`. The B699 shared-cause diagnosis + `NEW-WEBGPU-CUSTOMSHADER-TRANSLUCENCYMODE-ALPHA-UNDERAPPLIED`
intake (§4 pts 5/7) remain **G5-owned** and are numbered when that diagnosis slice is cut (G5 §G5.0) —
deliberately NOT minted here.

### 1.24 Uniqueness check (mechanical)

I verified the mapping mechanically while authoring: the numbered range is a **contiguous
`C11-01 … C11-156` with no gaps and no repeats** (per-cluster counts: pick 10, standing-reds 15,
splat 1, model-frontend 5, terrain-imagery 11, attachment-topology 8, rte-taa 7, frame-delta 6,
entity-scale 11, submit-residency 4, celestial-env 2, tiles-model-parity 19, classification-voxel 9,
shadows-lighting 4, atmosphere-sky 4, postprocess-effects 7, clouds-weather 7, water 1, test-infra 16,
build-boot 9 → **156**). Suffix ranges are contiguous and disjoint: `C11-GT-01..03` (3),
`C11-SEED-01..26` (26), `C11-IC-01..03` (3). Infra rows `C11-00`, `C11-00B`, `C11-GATE-D-CHECKPOINT`
are outside the register-item namespace. **Total register items placed = 156 + 3 + 26 + 3 = 188 =
the register's item count. No name appears under two IDs; no ID is reused.** Every existing
`NEW-*/C9-*/S*/FAR-*/C-R*/DP-*` name is preserved verbatim as an alias — nothing renamed
(register-preservation rule).

**2026-07-18 append addendum (`C11-00B` sweep).** §1.23 adds `C11-157..165` (9 numbered) and
`C11-SEED-27` (1 seed). The numbered range is now contiguous `C11-01..165`; the seed range contiguous
`C11-SEED-01..27`. I re-checked every appended ID mechanically against the FULL namespace (numbered
`C11-01..156`, `C11-GT-01..03`, `C11-SEED-01..26`, `C11-IC-01..03`, and the infra rows) via
`grep 'C11-15[7-9]|C11-16[0-9]|C11-SEED-2[7-9]'` → **zero pre-existing hits: no collision, no reuse, no
name under two IDs.** The three ratified parity directions that map to pre-existing rows (`C11-17`
background-color, `C11-91` silhouette body-wash, `C11-115` sun-blend) were recorded IN PLACE —
deliberately NOT re-minted — preserving append-only + register-preservation. The register-item baseline
is unchanged at **188**; the 10 appends are campaign-scheduled work items (ratified list + C10 fallout)
tracked separately from that baseline.

---

## 2. Rules (inherited verbatim from Campaign-9/10 §1 — do not weaken)

**★ GOVERNING PRINCIPLE (maintainer-ratified 2026-07-18, `C11-00B` sweep — binds every parity/defaults
slice in this campaign).** NEVER remove an additive WebGPU capability to reach parity — only change the
DEFAULT to match WebGL, keeping the enhancement reachable as a TOGGLE. **A parity fix that DELETES a
feature is WRONG.** This is the operative reading of rule 1 for the whole ratified parity family in
§1.23 / §7.0 (enhanced-ocean, night-lights, AutoExposure, sunBloom, sun-blend, `usePostProcessSelected`,
and the OIT-wiring lane): default classic/parity + preserve the enhancement behind a flag; land no slice
that reaches parity by amputation.

1. Never remove, hide, default-disable, bypass, or visually weaken a feature for a metric. Safety
   containment is correctness work, not a performance win.
2. Follow the WebGL globe architecture: WebGL and WebGPU consume the same backend-neutral
   `QuadtreePrimitive`/`GlobeSurfaceTileProvider` selected tiles. Never replace terrain quadtree,
   3D Tiles traversal, or voxel octree with the optional general `SceneOctree`; optimize their
   post-selection work and give non-PVS effects explicit owners.
3. Unknown attachment demand keeps MRT; unknown bounds execute the effect; unknown serial retains the
   resource; uncertain GPU visibility uses the correct fallback. Unknown demand stays conservative —
   never guess a skip.
4. No absolute planetary ECEF `f32` reconstruction before camera subtraction, including previous
   frames and GPU culling/LOD data.
5. Node/Playwright and Microsoft Edge only for browser automation. The moving multi-altitude camera
   track is mandatory; idle soak/FPS is not performance evidence.
6. Land one concern per slice. Roll back the optimization, never the feature. Tests and counters remain.

**Perf promotion rule (Campaign 9 §12.6, inherited verbatim).** An individual slice may raise a
promoted-optimization banner only when, versus its on/off/restored oracle on the moving-altitude
route, it improves a **named unsaturated stage p95 by ≥5%** OR exceeds **3× the measured run-to-run
noise**, with no route-segment p99 regression and no WebGL regression beyond the predeclared budget.
**A truthful miss with green mechanics (correctness oracles pass, structure changed as designed) is a
VALID, COMPLETE result** — record the honest number in the ledger and claim no banner. Structural
correctness/parity slices (the pick fleet, the frustum-count collapse to WebGL parity) land on their
own oracle regardless of the timing delta.

**Standing policy constraints carried into C11 (register §"Standing policy", C9 §3.3 record):**
WebGPU MRT-OIT default-off is RATIFIED FAR-003 containment (re-enable owner = FAR-003/T7, inactive
until post-Gate-F stop/go — do NOT flip it for a metric); `renderer:'webgpu'` graceful-fallback-
with-warn (strict via `strictRenderer`); the leave-dirty worker contract + orchestrator-only landing
(G10 §B2); machine-safety block verbatim in every brief (G10 §B3; ONE Edge at a time; 5-min watchdog;
scan generated scripts for unbounded loops; 32 GB RAM); push/commit as **kurtyoung-dev**.

---

## 3. Gates

Adapted from the C10 A/B/C/D set. Gate D is the C11 measured checkpoint; the **C8-upstream-contract
certification (`C11-137`) is the campaign EXIT gate** per G9 (§A.16 — "dead last").

| Gate | Required to pass | Stops promotion when |
| --- | --- | --- |
| A — launch seal / attribution | Fresh C11 launch seal on one clean hash; exact source/build identity; clean + API lanes on the moving-altitude route; deterministic offline boot; known-error ledger. **Anchor = the recorded `C9-30` clean-r5 artifact** (`campaign9-c9-30-checkpoint-clean-r5-2026-07-17.json`, WebGPU 5.20 / WebGL 5.31 ms whole-route CPU p95) or, if C10-30 recorded a fresher anchor, that — never re-derive a fresh baseline on the new tree; Gate-A `B8015811…` (WebGL 5.50 / WebGPU 7.51 ms) is the labelled fallback. | A route is incomplete, rendering pauses, hashes differ, clean/instrumented data mix, or device errors are unexplained. |
| B — bounded correctness / feature preservation | Every slice's own semantic + visual oracle green; the pick-fleet WebGL-parity matrix; frustum-count/env-pixel parity; byte-identical off-paths and kill switches. The standing reds (`C11-01` pickposition, `C11-11` spheres drift, bare-globe interior) tracked and **pre-attributed** via their W1 diagnoses. | A public result, feature, mode, depth/history contract, or visual is weakened; a standing red turns a NEW red. |
| C — default hot path | Per-slice on/off/restored evidence on the moving-altitude clean + API lanes; ≥5% named-stage p95 or >3× noise for any banner; no route-segment p99 regression; no WebGL regression beyond the predeclared budget. | Improvement is within noise, a route segment regresses, or an unknown consumer is skipped. |
| D — measured checkpoint (`C11-GATE-D-CHECKPOINT`) | The perf-tranche checkpoint on one rebuilt hash vs the anchor: **≥10% whole-route + ≥15% near-ground (seg 5+6) WebGPU CPU-p95 OR >3× noise**; feature-loss gate green (standing reds pre-attributed, NO new red); honest per-stage attribution + promote/iterate verdict recorded. A truthful MISS with green mechanics is VALID = record "iterate" + per-stage attribution + gated-tail recommendation. | A lane is absent, historical evidence is overwritten, the anchor is re-derived on the new tree, or a new visual red appears. |
| **EXIT — C8 upstream-contract certification (`C11-137`)** | **RATIFIED 2026-07-18: BOTH lanes** — the campaign CLOSES on the **deterministic `C11-137` C8-contract gate with truthful counts** (the focused/unit lane is the close bar); the **full real-scene suite additionally runs when a real adapter is available** and is a **recorded follow-up, NOT a close-blocker** (resolves G9 Q1/Q2, §7.0/§7.2). Full engine + widgets + complete-engine suite run on the **stabilized** launcher (`C11-133`), offline lane isolated (`C11-134`), spec bundle fresh (`C11-132`); truthful executed/passed/skipped/failed counts with every skip reasoned (WebGL2-only per Principle 4, requires-network per A.3, requires-adapter per A.4); zero unowned reds; the four owner items (`C11-138`/`C11-142`/`C11-143`/`C11-144`) landed; GraphicsCapabilities Renderer-triage re-asserted zero-attribution; committed certification report = the C11 exit evidence. | Any owner item is open, the environment is flaky, a skip is a silent pass, or a DataSources failure is unowned. The campaign does NOT certify — say so plainly (honest-partial). |

R0/R1 infra, counters, probes, and structural-correctness slices may land before Gate B. The gated
tail (§6) is not activated by any of these gates alone — it additionally requires the Gate-D verdict
AND fresh maintainer sign-off.

### 3.2 Live execution ledger (seeded — every C11-id NOT STARTED at launch)

Status vocabulary (identical to C9/C10 §3.2): **IN PROGRESS · COMPLETE · PARTIAL / PAUSED · BLOCKED ·
DEFERRED · CONDITIONAL NOT TRIGGERED · NOT STARTED**. Every brief mandates: update your row here with
status + evidence, INCLUDED in your landed files. A missing ledger update is a landing defect. All
185 schedulable/gated/seed rows + the 3 intake rows below seed **NOT STARTED** with the guide pointer;
evidence-pending (**plus the 10 launch-reorder appends §1.23 — `C11-157..165` + `C11-SEED-27` — also
seeded NOT STARTED / DEFERRED below**). (Rendered compact — one line per id; the orchestrator expands a row to the C10-style
evidence paragraph as each slice lands.)

| Rows | Seeded status | Guide pointer | Evidence |
| --- | --- | --- | --- |
| `C11-00`, `C11-00B`, `C11-GATE-D-CHECKPOINT` | `C11-00` DEFERRED (orchestrator); **`C11-00B` COMPLETE (2026-07-18 fallout-intake + launch-reorder sweep — this doc)**; `C11-GATE-D-CHECKPOINT` NOT STARTED (anchor input = `C11-SEED-27` clean-env re-measure) | G10 §B6 / §B7 | C10 closed Batch 711 `9a52717cf2`; sweep output = §1.23 + §7.0 + §4 |
| `C11-01 … C11-10`, `C11-IC-01` (pick) | NOT STARTED | G1 §A/§0 | evidence-pending |
| `C11-11 … C11-25` (standing-reds) | NOT STARTED | G1 §B (C11-13 → G6 A1) | evidence-pending |
| `C11-26` (splat producer), `C11-IC-02` | NOT STARTED · BLOCKED-ON-MAINTAINER | G5 §G5.1 | evidence-pending |
| `C11-27 … C11-31` (model-frontend) | NOT STARTED | G4 §1 | evidence-pending |
| `C11-32 … C11-42` (terrain-imagery) | NOT STARTED | G2 | evidence-pending |
| `C11-43 … C11-50` (attachment-topology) | NOT STARTED | G3 | evidence-pending |
| `C11-51 … C11-57` (rte-taa) | NOT STARTED · **no cluster guide** | register §7 + PR §4/§8 | evidence-pending |
| `C11-58 … C11-63`, `C11-SEED-01` (frame-delta) | NOT STARTED | G4 §2 | evidence-pending |
| `C11-64 … C11-74`, `C11-SEED-02` (entity-scale) | NOT STARTED | G7 | evidence-pending |
| `C11-75 … C11-78` (submit-residency) | NOT STARTED | G2 §submit | evidence-pending |
| `C11-79 … C11-80` (celestial-env) | NOT STARTED | G7 Item 12/13 | evidence-pending |
| `C11-81 … C11-99`, `C11-SEED-03/04` (tiles-model-parity) | NOT STARTED | G5 | evidence-pending |
| `C11-100 … C11-108` (classification-voxel) | NOT STARTED | G6 §A | evidence-pending |
| `C11-109 … C11-112`, `C11-SEED-05` (shadows-lighting) | NOT STARTED | G8 | evidence-pending |
| `C11-113 … C11-116`, `C11-SEED-06/07` (atmosphere-sky) | NOT STARTED | G8 | evidence-pending |
| `C11-117 … C11-123`, `C11-SEED-08/09` (postprocess-effects) | NOT STARTED | G6 §B | evidence-pending |
| `C11-124 … C11-130`, `C11-SEED-10..18` (clouds-weather) | NOT STARTED · **no cluster guide** | register §17 | evidence-pending |
| `C11-131`, `C11-SEED-19` (water) | NOT STARTED | G8 §water | evidence-pending |
| `C11-GT-01 … C11-GT-03` (gated-reversed-z) | DEFERRED (gated tail §6) | G10 §A1–A3 | gate-pending |
| `C11-132 … C11-147` (test-infra) | NOT STARTED (`C11-137` = EXIT) | G9 §A | evidence-pending |
| `C11-148 … C11-156`, `C11-SEED-20/21/22`, `C11-IC-03` (build-boot) | NOT STARTED | G9 §B | evidence-pending |
| `C11-SEED-23 … C11-SEED-26` (arch-seeds) | DEFERRED (seed) | G10 §A4–A7 | seed-pending |
| `C11-157` (OIT translucent-primitive wiring) | **PARTIAL (Slices A+B: PRIMITIVE + COLLECTION families DONE, 2026-07-18/19)** | §1.23 / G1/G3 | **TOP of W1**; absorbs `C11-91` body-wash; Batch-700 fallout. **Slice A (Batch 713)**: translucent PRIMITIVES (flat single-`@location` PrimitiveBasicColor + LIT `FragOutput`-struct PrimitivePhongColor via new `injectOITOutput` struct branch) REACH MRT-OIT — `_webgpuOITActiveThisFrame`=TRUE, WebGPU OIT-on now **1.33%** from WebGL OIT-on (was 10.33% @ Batch-700). **Slice B**: translucent COLLECTIONS (billboard / point / polyline color commands, all `FragOutput`-struct FS → the same struct branch) now REACH MRT-OIT too — `probe-oit-collection-reachable.mjs` point/polyline/billboard all PASS (`activeThisFrame`=TRUE was-always-false, 0 validation errors, non-degenerate WBOIT blend, restore 0px). Wiring: `WebGPU{Billboard,PointPrimitive,Polyline}Renderer.js` attach `_shaderCode` (non-LOG_DEPTH source) + `_pipelineConfig` (base pipeline's shared layout, single-sample) to each Pass.TRANSLUCENT color command. **Slice C (MODEL core)**: translucent MODELS now REACH MRT-OIT — both the natively-BLEND primary command AND the per-feature-styled TRANSLUCENT **twin** (C10-02 / Batch 699). `WebGPUModelPipelineCache` gained `getOITColorConfig` (extracted `_composeColorSource` — byte-identical module composition — + non-LOG_DEPTH preprocess + reused color descriptor); `WebGPUModelRenderer` attaches it to the primary (when `pass===TRANSLUCENT`, non-classifier, non-silhouette) + the twin (both inside the Batch-704 async ready-gate). Also fixed a latent `executeOITCommand` bug: it assumed the `{buffer}` wrapper and threw `setIndexBuffer: not a GPUBuffer` on models (raw GPUBuffer) — now `resolveOITBuffer` handles both (unblocks models; A/B unaffected). `probe-oit-model-reachable.mjs` twin+blend PASS (`activeThisFrame`=TRUE, 0 errors, model renders via composite, restore 0px; onVsOff≈0 is CORRECT — single-sided model geometry → WBOIT≡sorted-alpha). Model battery unregressed (instance-bg-cache, pbr-ibl-parity, standalone-model-pick). No-regression: primitive-reachable + collection-reachable + oit-transparency (parity 1.33%) + splat-sort + ellipsoidprim + globe-translucency + capture-and-diff all green. FAR-003 stays DEFAULT-OFF (reachable, not default-on). **Slice D REMAINS** = the C11-91 silhouette OIT "body wash" (design-heavy stencil/pass work, deferred + designed in DEFERRED_WORK). Runs at `msaaSamples=1` (MSAA×OIT = `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`). Weight follow-up = `NEW-WEBGPU-OIT-WEIGHT-LINEAR-DEPTH` |
| `C11-158` (enhanced-ocean default-parity toggle) | NOT STARTED | §1.23 / G8 | W4; HARD PRED `C11-149`; with `water-bugs-2026-07-06` |
| `C11-159` (night-lights default-OFF parity) | NOT STARTED | §1.23 / G8 | W1 cheap rider; keep toggle |
| `C11-160` (sunBloom → PP wiring) | NOT STARTED | §1.23 / G6/G8 | W7 after `C11-117` |
| `C11-161` (AutoExposure demand-gate) | NOT STARTED | §1.23 / G6/G8 | W7 after `C11-117` inventory |
| `C11-162` (usePostProcessSelected port) | NOT STARTED | §1.23 / G6 | W7 |
| `C11-163` (C11-CELESTIAL-WATER-REFLECTION epic) | NOT STARTED · Tier-4/gated | §1.23 / G8 + `CELESTIAL_WATER_REFLECTION_RESEARCH.md` | opt-in default-OFF; 4 sub-decisions §7.0 |
| `C11-164` (pick cold-sync-staleness race) | NOT STARTED | §1.23 / G1 | W2 pick fleet; C10-11 fallout |
| `C11-165` (deterministic-sync pipeline centralization) | NOT STARTED | §1.23 / G9 | W4 boot chain; C10-07 follow-on |
| `C11-SEED-27` (C10-30 clean-env r5 re-measure) | DEFERRED (seed) | §1.23 / G10/G9 | Gate-D anchor input |

---

## 4. `C11-00B` launch intake (summary — full procedure in G10 §B6)

> **EXECUTED 2026-07-18 — `C11-00B` COMPLETE.** Campaign 10 CLOSED at **Batch 711 (`9a52717cf2`)**.
> Sweep results are folded below and into §1.23 (appended rows), §3.2 (seeded ledger), and §7.0
> (resolved decisions).
>
> - **C10-30 verdict:** green mechanics + deterministic **−33% render-passes/frame**; wall-clock
>   **env-confounded → iterate (no banner)**. The clean-environment r5 **re-measure is a C11 follow-up**,
>   seeded as **`C11-SEED-27`** (Gate-D reference). Gate A still anchors on the recorded `C9-30` clean-r5
>   artifact per §3 — the new tree is NOT re-baselined.
> - **Boot chain:** `C10-08` BLOCKED at C10 close (registry EXHAUSTED — bits 0–30 used; the fragile
>   sign-bit 31 was deliberately NOT consumed per the ruling) → **`C11-149` define-width is the HARD
>   PREREQUISITE, pulled to W1** to widen the registry; it unblocks the `C11-158` enhanced-ocean toggle. The `C10-07` follow-on
>   `NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-CENTRALIZATION` is seeded as **`C11-165`**.
> - **Pick fleet:** `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (`C11-IC-01`) DONE, but the **reversed-Z-convert-
>   back surface is noted** — read the `C11-GT-01` reconciliation record before treating the log-depth
>   conversion permanent (same 71-file surface). The C10-11 **cold-page async-pick-readback RACE** is
>   seeded as **`C11-164`** (distinct from the June-361 docs-only close of the same name).
> - **Batch-700 OIT NO-GO:** the real prerequisite `NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` is
>   intaken as **`C11-157`** — RESOLVED to **FULL primitive→collection→model wiring, TOP of W1** (§7.0);
>   silhouette body-wash (`C11-91`) folds in. MRT-OIT default-off stays FAR-003-contained (not a metric
>   flip).
> - **Splat** (`C10-04`) stays BLOCKED-ON-MAINTAINER (`C11-26` producer → `C11-IC-02`). **High-density
>   drift** = `C11-11` (diagnose-first, lean repair — §7.0).
> - **Reversed-Z** (`C11-GT-01`): its measurement-only spike is pulled into **W1** (slice work stays
>   gated §6). If C10 already ran it, its verdict is a `C11-00B` fact recorded in all three sinks.
> - A launch note + `git branch -a` inventory were presented to the maintainer before the first slice.

Run ONCE at launch, BEFORE the first slice. It converts everything still open when C10 closes into
owned C11 rows so nothing falls through the C10→C11 seam (the load-bearing bridge, exactly as
`C10-00B` was for C9→C10). **Re-sweep the LIVE C10 ledger** (`QUEUE_2026-07-16_CAMPAIGN10.md` §3.2) —
the register sweep was HEAD `aef553d592` (Batch 698); the tree has since moved (C10 landed Batches
693–699+). Absorb, as seeded ledger rows:

1. **The `C10-30` measured-checkpoint verdict.** If it MISSED, its per-stage attribution REORDERS C11
   waves (the stage carrying the most unrecovered cost names the highest C11 lever) and is the trigger
   input for the reserve levers (`C11-GT-03`) and the gated tail. If it PASSED (or never ran and
   `C11-GATE-D-CHECKPOINT` re-runs it), record the anchor per Gate A. Target unchanged: ≥10%
   whole-route + ≥15% near-ground WebGPU CPU-p95 OR >3× noise.
2. **The boot chain `C10-06` / `C10-07` / `C10-08`.** `C10-06` outcome determines whether `C11-153`
   (S8-4 FR-lazify) is absorbed or standalone; `C10-07` sequences `C11-150` (module granularity)
   after; **`C10-08` gates `C11-149` (C10-08b define-width)** — the ShaderDefine registry is EXHAUSTED
   (bits 0–30 used; C10-08 was BLOCKED because only the fragile sign-bit 31 remained and the ruling
   forbade consuming it), so `C11-149` is the HARD prereq for any new define bit
   (`C11-92` Q31 varyings, `C11-88` KHR gates, `C11-89`, `C11-81`, `C11-131` OCEAN_PLANAR_REFLECT).
3. **The pick fleet `C10-11` / `C10-12` + the 5 W4 riders.** `C10-11` owns `C11-IC-01`
   (NEW-WEBGPU-PICK-FLEET-LOG-DEPTH); `C10-12` closes `C9-02A` (`C11-06`) + audits `P0-1` + flips
   `PICK_DEPTH_PLANE_ENABLED`. C11 picks up only what W4 leaves: `C11-02`/`C11-03`/`C11-04`/`C11-05`/
   `C11-12` (each on its own oracle, no metric). **Verify the `C10-11` outcome AND its `C10-13`
   reversed-Z reconciliation record before treating the log-depth conversion permanent** (G10 §A1).
4. **The `C10-13` reversed-Z spike outcome (`C11-GT-01`).** Its GO/NO-GO redirects the entire
   `gated-reversed-z` cluster (`C11-GT-01/02`) AND the pick fleet (same 71-file surface, opposite
   directions). If it already ran in C10, its verdict is a C11-00B fact.
5. **The Batch-700 OIT NO-GO.** `M-OIT-COVERAGE-AND-FLIP-EVIDENCE` verdict = **NO-GO (flip nothing)**.
   WebGPU MRT-OIT is unreachable for standard translucency — the composite line has never executed
   (only Gaussian splats + opaque globe produce `_shaderCode`). The real prerequisite is
   **`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING`** (**intaken as `C11-157`, RESOLVED 2026-07-18 to
   FULL primitive→collection→model wiring, TOP of W1 — §7.0**) + the two live FAR-003 adjacencies
   (`C11-18`, `C11-23`). Also intake the pre-existing
   Batch-699 `NEW-WEBGPU-CUSTOMSHADER-TRANSLUCENCYMODE-ALPHA-UNDERAPPLIED`. MRT-OIT default-off stays
   RATIFIED FAR-003 containment — do NOT flip it for a metric.
6. **The defaults-parity runtime pass results.** `DEFAULT_PARITY_MATRIX_2026-07-18.md` catalogs 22
   backend default divergences (5 visible-visual) feeding G8 — enhanced-ocean #1, night-lights,
   AutoExposure, background-color (`C11-17`), the OIT flip (now NO-GO). Its runtime-verification
   results are C11-00B facts; each surviving flip candidate becomes a seeded row with the maintainer
   sign-off protocol attached (a default-visual flip is CLAUDE.md Rule 1 policy). **Enhanced-ocean is
   NOT a clean flip** (§7).
7. **The two Batch-699 findings that plausibly share one cause:**
   `NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` + `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY` —
   `FLAG_HAS_FEATURE_ID_ATTRIBUTE` never set for b3dm content. **Intake as ONE shared instrumented
   diagnosis (G5 §G5.0/§0) before slicing either** — seed a single new C11 row for the shared
   diagnosis, sequenced ahead of `C11-82`/`C11-84`.

**Output of `C11-00B`:** the seeded §3.2 ledger + a one-paragraph launch note ("C10 landed X/N;
fallout intaken as M rows; C10-30 verdict = pass|iterate; C11 wave order adjusted by <attribution>")
presented to the maintainer BEFORE the first slice, with a `git branch -a` inventory. Resolve any
LAND-INCOMPLETE unpushed commits first; launch on a clean tree (`tsc` green).

---

## 5. Waves

Waves are executed **strictly sequentially inside the loop** — "wave" is a planning grouping, not
concurrency. Order within a wave is the `TASKS` order. `C11-00`/`C11-00B` run before W1. The wave
column of §1 is authoritative per item; the synthesis below states the rationale and the hard
constraints honored.

**Sequencing rationale (from the guides):** clear the standing reds + environment first so later waves
stop paying OFF-oracle costs against known-red gates (G1 Q9, G9 §6); land the cheap high-leverage
correctness/parity riders that gate nothing; run `C10-08b` define-width (`C11-149`) BEFORE any
new-define item (registry EXHAUSTED — G9 §0); keep the XL epics (MRT topology, terrain retention,
S10 arc, reversed-Z) in later waves behind their prereqs; the 3 maintainer-decision items are
BLOCKED-ON-MAINTAINER and do not open on an engineering default; measure, then certify.

### W1 — OIT-wiring (TOP), reversed-Z spike, define-width, standing-reds, diagnosis, environment, cheap riders, reconciliation

**Reordered 2026-07-18 (ratified).** The "stop paying the OFF-oracle tax" wave, now fronted by the OIT
wiring and the two early spikes. Contents:

- **★ TOP OF W1 — `C11-157` OIT translucent-primitive wiring (ratified 2026-07-18).** FULL
  primitive→collection→model wiring; the `C11-91` silhouette body-wash "replicate WebGL" resolution
  folds in here. This is the Batch-700 OIT NO-GO's real prerequisite (no primitive/model/collection
  currently emits a `Pass.TRANSLUCENT` command carrying `_shaderCode`/`_oitPipeline`). **MRT-OIT
  default-off stays RATIFIED FAR-003 containment — do NOT flip the metric.** Multi-batch; opens W1.
- **Reversed-Z measurement spike EARLY — `C11-GT-01` (ratified 2026-07-18, measurement-only).** Run the
  `C10-13-REVERSED-Z-EARLYZ-SPIKE` here as **measurement-only** (moved out of the gated tail; the SLICE
  work `C11-GT-02` stays gated §6). Record its GO/NO-GO in `C11-IC-01` + the FAR-707 brief +
  `DEFERRED_WORK.md`; it gates the pick-fleet log-depth reconciliation (the 71-file surface hazard).
- **Define-width EARLY — `C11-149` (C10-08b).** `C10-08` was BLOCKED at C10 close (registry exhausted;
  the sign-bit 31 deliberately left unconsumed), so define-width is the prerequisite and pulled into W1. It is the HARD PREREQ that unblocks the `C11-158` enhanced-ocean toggle
  (and later `C11-92`/`C11-88`/`C11-89`/`C11-81`/`C11-131`).
- **The cheap RATIFIED parity fixes (W1 cheap riders):** `C11-17` (empty-scene background-color FIX),
  `C11-159` (night-lights default-OFF, keep toggle). *(The remaining ratified parity fixes land later:
  `C11-158` enhanced-ocean toggle in W4 after define-width; `C11-160` sunBloom-wire, `C11-161`
  AutoExposure demand-gate, `C11-162` usePostProcessSelected port in W7 behind the `C11-117` effect
  audit — see §1.23 / §7.0.)*

Then the original W1 contents:

- **Two checkpoint-gating diagnoses (fable, diagnosis-only):** `C11-01` (pickPosition convergence) +
  `C11-11` (high-density-spheres cross-backend drift). Scheduling these in W1 pre-attributes the two
  reds so every later slice's feature-loss oracle is meaningful (G1 §A1/§B1, Q9). *If B1 traces to a
  contained GPU-cull path, the repair is BLOCKED-ON-MAINTAINER (charter forbids degrading the feature
  for the metric — §7).*
- **The G9 environment prerequisites (hard, W1):** `C11-133` (Karma launcher determinism), `C11-132`
  (spec-bundle freshness), `C11-134` (offline isolation). Until all three are COMPLETE, no spec/gate
  claim in the whole campaign is falsifiable (G9 §6). Two exit-gate owners (`C11-136`, `C11-144`) are
  paused specifically on them.
- **Perf-claim prerequisite tooling (early):** `C11-140` (GPU-timestamp unique-sample cert), `C11-146`
  (first-complete-frame metric). An uncertified timer silently invalidates every later perf number
  (G9 Q7).
- **The cheap stale-premise RECONCILIATION slice (fable — the task's named W1 slice):** one pass that
  corrects the register/FEATURE_INVENTORY rows the guides flagged stale, so later briefs cut against
  truth: SHADOW-LAYOUT-QUANTIZED (`C11-109`, likely doc-close — G8 Q4), C-R10 receive-infra-present
  (`C11-111`), C9-14B fog-LUT-already-sampled (`C11-113`), `WebGPUComputePipelineCache` EXISTS →
  re-scope to routing (`C11-156` — G9 Q4a), `WebGPUModelRenderer` already `.ts` → strike from
  `C11-154`'s list (G9 Q4b), plus the G5 "cluster-12 reconciliation" and G8 "cluster-14/15/18
  reconciliation" premise-verify passes. Also re-point the C-R9 row (`C11-103`) at the object-pick
  footprint residual (G6 Q3) and note `scene.pickVoxel` no longer throws.
- **Cheap high-leverage riders (gate nothing):** `C11-17` (canvas-background parity), `C11-16`
  (point BlendOption sync), `C11-22` (debug-depth-plane gate parity), `C11-35` (oceanNormal per-call
  reupload cache), `C11-79`/`C11-80` (celestial retained / starfield single-submission — instrument
  `C11-80` first, G7), `C11-41` (F2a prompt-retire verification lane).
- **Self-contained P0/cheap correctness:** `C11-13` (voxel-inside-camera-black, G6 A1), `C11-51`
  (TAA custom-frustum jitter crash-fix, S), `C11-14` (WebGL aniso GLSL broken), `C11-15` (FR
  failed-state retry), `C11-19` (globe pipeline-name axes), `C11-24` (RenderCommand stale-pass-slot),
  `C11-25` (OPEN-1-DIAGNOSE verify-then-close).

### W2 — pick fleet closure + FAR-107 contract + pick correctness

The W4-riders C11 inherits from C10 (each on its own oracle, no metric): `C11-02`, `C11-03`, `C11-04`,
`C11-05`, `C11-06` (intake-conditional on `C10-12`), `C11-12` (MSAA-flip transition). Then the
foundations: `C11-07` (FAR-107 pick-query contract — needs maintainer public-API review, §7),
`C11-08` (multi-frustum packed depth — dep `C11-07`), `C11-09` (polyline-appearance pick remainder),
`C11-10` (main-scene depth blit), `C11-78` (pick-ID ownership model). **Read the `C10-11` outcome +
its `C10-13` reconciliation record before any depth-adjacent pick slice** (G10 §A1; the 71-file
surface hazard).

### W3 — bandwidth, attachment, terrain riders, model/frame-delta riders, submit timeline

The cheap-to-mid perf riders with no XL prereq. Attachment/MSAA: `C11-44`, `C11-45`, `C11-46`,
`C11-47`, `C11-48`, `C11-50` (payoff probe — MUST precede `C11-43`/`C11-49`, G3 Q4). Terrain riders:
`C11-34`, `C11-36`, `C11-37` (after `C11-33`), `C11-39`, `C11-40`, `C11-42`. Model-frontend riders:
`C11-28` (S9-2) → then `C11-30`, `C11-31`. Frame-delta: `C11-58` (S1-3 — land before entity `C11-65`
slice (d) to avoid double-churn, G7 Q4), `C11-59`, `C11-60`, `C11-61`, `C11-62`, `C11-72`. Submit
timeline (G2 §966): `C11-76` submitter-moves FIRST, then `C11-75` shadow-timeline authority. Latent
correctness: `C11-20`, `C11-21`. Route `C11-156` consumers through the (existing) compute-pipeline
cache. **Never run two of `C11-32`/`C11-33`/`C11-34` concurrently — same tile-buffer lifetime.**

### W4 — boot / compile chain + define-width + TS-debt

Intake-conditional on the C10 boot triad (`C10-06/07/08`). **2026-07-18: `C10-08` LANDED at C10 close,
so `C11-149` (C10-08b define-width) was pulled forward to W1 (§5 W1) — the rest of the boot chain stays
here.** `C11-149` remains **the HARD PREREQ for every new-define item** (`C11-92`, `C11-88`, `C11-89`,
`C11-81`, the `C11-131` OCEAN_PLANAR_REFLECT bit, **and the `C11-158` enhanced-ocean `ENHANCED_OCEAN`
gate**). Then `C11-150` (module granularity, after `C10-07`), `C11-148` (per-backend material source),
`C11-151`, `C11-152` (→ enables the leaf-strip seed), `C11-153` (S8-4, if `C10-06` didn't absorb it),
`C11-155`, `C11-154` (TS-convert, one renderer per batch — `WebGPUModelRenderer` already `.ts`, struck),
and **`C11-165`** (NEW-WEBGPU-DETERMINISTIC-SYNC-PIPELINE-CENTRALIZATION, the C10-07 follow-on).
`C11-81`/`C11-89`/`C11-92` open here once define-width lands; **`C11-158` (enhanced-ocean default-parity
toggle) also opens here after `C11-149`, landing jointly with the OPEN `water-bugs-2026-07-06` fix so the
ratified default isn't a buggy one.**

### W5 — RTE / TAA temporal contracts (no cluster guide — commission one first)

`C11-52` (C9-24 RTE producer/consumer inventory — R0 foundation) → `C11-53` (C9-25 previous-frame
RTE), `C11-54` (C9-26 GPU-visibility RTE closure), `C11-55` (C9-29 multi-frustum TAA depth
reprojection). Then the TAA-design tail `C11-56` → `C11-57`. **`C11-52` is the prerequisite for the
others + Gate E-class precision.** No dedicated guide exists for `rte-taa` — the orchestrator should
author a G-guide (or a detailed brief pack) before opening `C11-52`.

### W6 — XL epics (behind their prereqs)

- **MRT topology:** `C11-43` (C9-10 consumer-driven MRT) — its P0 prereq is the MRT-topology
  dimension in the pipeline-cache key of ALL 31 `makeSceneFBTargets` renderers (collection key is
  32/32 bits — widen); `CesiumDebug.attachmentDemand(false)` refuses until the key audit lands
  (G3 §1). Phase: P0 key-audit → P1 demand-wire → P2 default flip (`forceSceneMRT` flip is
  maintainer-gated, §7).
- **Terrain retention family (dedicated, do NOT open inside a normal wave):** `C11-33` (C9-11 retained
  descriptors) is the prereq store for `C11-32` (C9-12 static/dynamic upload split); `C11-38` (S6-3
  uniform-ring fan-out) extends the same WGSL+packer+BG-cache family; `C11-34` residency budget rides
  here. Multi-batch acceptance matrix required (water/clipping/shadow/exaggeration/2D-CV-morph/
  multi-view/device-loss).
- **Model-frontend heavy:** `C11-27` (C9-17 Slice D) — STOP-gated: opens ONLY if Gate-D / recorded
  C9-30 attribution names model-frontend allocation (G4 Q1); then `C11-29` (S9-3, sequence-locked
  after Slice D), and `C11-63` (revision-maintained caster sublist — blocked on the S1-6 tier seed
  `C11-SEED-23`).
- **Residency dedupe:** `C11-77` (geometry-residency dedupe — gated on a written typedArray-release
  policy that preserves documented readers, G10 §A7).

### W7 — parity + content + entity-at-scale arc + test-infra closure

The broad parity/feature wave, and the S10 arc:

- **Entity-at-scale (S10):** `C11-64` (10k-entity benchmark lane) is FIRST and gates every other S10
  finding (G7 §45); then `C11-65`, `C11-66` (dep the lane), `C11-67`, `C11-68`, `C11-69` (after
  FAR-107 `C11-07`), `C11-70`, `C11-71`, `C11-73`, `C11-74`. Whether the L-sized `C11-65/66` wait for
  the Gate-D attribution is a maintainer call (G7 Q6).
- **Post-process visibility:** `C11-117` (C9-23 effect-execution audit) opens the cluster FIRST (its
  consumer inventory feeds the AutoExposure gate, G6 §B1) → then `C11-118..123`. **The ratified PP
  parity wirings land behind `C11-117`:** `C11-160` (sunBloom → WebGPU PP Bloom/LensFlare), `C11-161`
  (AutoExposure demand-gate — its "no consumer enabled" evidence comes from the `C11-117` inventory),
  `C11-162` (usePostProcessSelected port). *(Default-pixel changes → the enhancement-preserving governing
  principle §2 applies; keep the WebGPU capability reachable.)*
- **Tiles/model parity:** `C11-82`, `C11-83`, `C11-84`, `C11-85`, `C11-86`, `C11-87`, `C11-88`,
  `C11-90`, `C11-91` (maintainer decision), `C11-93`, `C11-94`/`C11-95` (behind `C11-27`/`C11-29`),
  `C11-96`, `C11-97`, `C11-98`, `C11-99`. `C11-26` splat-producer (BLOCKED-ON-MAINTAINER) unblocks
  `C11-18`, `C11-105`, `C11-IC-02`.
- **Classification/voxel:** `C11-100` (sliced; A2-slice-0 triage first), `C11-101` (.vctr fixture
  prereq), `C11-102`, `C11-103`, `C11-104`, `C11-105` (dep `C11-26`), `C11-106`, `C11-107`, `C11-108`.
- **Shadows/atmosphere/water/clouds:** `C11-110`, `C11-111`, `C11-112`; `C11-113` (gated on checkpoint
  attribution), `C11-114`, `C11-115` (**RESOLVED 2026-07-18: ALPHA_BLEND, §7.0**), `C11-116`; `C11-131`
  (after define-width / reversed-Z disposition); `C11-124..130` (clouds-weather — commission a guide
  first; `C11-126` CLOUD-U4 **RESOLVED 2026-07-18: option (A), §7.0**).
- **Celestial-water epic (Tier-4 / gated):** `C11-163` (C11-CELESTIAL-WATER-REFLECTION) — unified
  sun-by-day + moon/stars-by-night reflection on water + clouds, cloud-occluded via the EXISTING O(1)
  sun-view beer-shadow-map (no per-fragment raymarch), cloud-top specular fallback. **Opt-in
  default-OFF, byte-identical when off; runtime UBO enable-float (NO new define bit, NO `C11-149` dep);
  the cheap path does NOT touch depth (NOT reversed-Z-coupled).** Front-of-line S0 = day-sun-glint
  audit/unify (upgrade the existing `GlobeTerrain.wgsl:2441` sun glint to the same Cook-Torrance GGX
  lobe). Its **4 sub-decisions resolve when scheduled (§7.0)**. Full dossier:
  `CELESTIAL_WATER_REFLECTION_RESEARCH.md`.
- **Attachment future:** `C11-49` (Phase-8a normal G-buffer + depth prepass — maintainer-scoping gate).
- **Test-infra closure (exit-gate owners land here, mid-late):** `C11-138` (item 66, cheapest),
  `C11-142` (item 67), `C11-143` (item 69), `C11-144` (item 70), `C11-136` (item 64 broad-suite),
  `C11-135` (adapter matrix), `C11-141` (visibility manifest), `C11-139` (baseline promotion — after
  `C11-11` spheres repaired), `C11-145`, `C11-147` (after globe/HDR pixels settle).

### W8 — measured checkpoint + gated-tail evaluation

`C11-GATE-D-CHECKPOINT` (measurement-only; predeclare the anchor; clean then API lane; `--workload
moving-camera-altitude-track-3d --repetitions 5 --renderer both`; never re-derive a fresh baseline).
Its verdict decides which gated-tail items get pulled (§6): the `C11-GT-01` reversed-Z spike verdict
(if not already run in C10) is recorded in all three sinks; `C11-GT-03` MSAA-default-flip reserve
triggers only on a MISS with bandwidth-attributed evidence + fresh sign-off.

### EXIT GATE — `C11-137` C8-upstream-contract certification (DEAD LAST)

The campaign closer (G9 §A.16). Full engine + widgets + complete-engine suite on the stabilized
launcher with truthful executed/skipped/failed counts, every skip reasoned, zero unowned reds, the
four owner items landed, GraphicsCapabilities Renderer-triage re-asserted. The committed certification
report IS the C11 exit evidence. If any owner item did not land, the gate stays **OPEN** and the
campaign does not certify — say so plainly (honest-partial). **RATIFIED 2026-07-18 (resolves G9 Q1/Q2):
the campaign CLOSES on the deterministic `C11-137` C8-contract gate with truthful counts (the
focused/unit lane is the close bar); the FULL real-scene suite ADDITIONALLY runs when a real adapter is
available and is a recorded follow-up, NOT a close-blocker.** "Campaign certifies" = "`C11-137` closes
green with truthful counts."

---

## 6. Gated tail + arch-seeds (from G10 Part A — do NOT auto-run)

Activated ONLY by the Gate-D verdict AND fresh maintainer sign-off. Not scheduled by the loop. Full
dossiers: **G10 §A1–A7.**

| C11-id | Item | Gate to open |
| --- | --- | --- |
| `C11-GT-01` | `C10-13-REVERSED-Z-EARLYZ-SPIKE` (measurement-only, openable) | **RATIFIED 2026-07-18: the measurement-only SPIKE runs EARLY in W1** (moved out of the gated tail — it changes no shipped behavior; only the reversed-Z SLICE `C11-GT-02` stays behind Gate-D + fresh sign-off). Cheap FAR-707 evidence gate; GO threshold ≥20–30% fragment-work reduction on weak-FPS views. **MUST record its GO/NO-GO in BOTH `C11-IC-01` (NEW-WEBGPU-PICK-FLEET-LOG-DEPTH) AND the FAR-707 brief AND `DEFERRED_WORK.md`** before the pick fleet's log-depth conversion is treated as permanent — the two streams pull the same 71-file surface opposite ways. If C10 already ran it, its verdict is a `C11-00B` fact. |
| `C11-GT-02` | `C10-GT-REVERSED-Z-SLICE-B` (DEFERRED — do not schedule) | All of: `C10-01` landed (done, B693); `C11-GT-01` GO; the pick-fleet reconciliation decision recorded; a written `depth32float-stencil8` fallback story covering every adapter tier (any tier left behind = forbidden dual permanent architecture = NO-GO); Gate-D verdict + fresh sign-off. XL, all-or-nothing behind `_reversedZEnabled` (OFF = byte-identical). **Trap:** if GO, the RGBA8 pack ecosystem `C11-45`/`C11-46` optimize is slated for DELETION — land them near-term but sequence BEFORE any reversed-Z commitment and mark them superseded-by-design. |
| `C11-GT-03` | `C10-03R-MSAA-DEFAULT-FLIP-RESERVE` (CONDITIONAL NOT TRIGGERED) | Reserve lever. Pull ONLY on a Gate-D MISS WITH bandwidth-attributed evidence (GPU-timestamp + counters implicating attachment traffic, NOT CPU) AND fresh maintainer sign-off recorded here. Backend-conditional WebGPU default `msaaSamples` 4→1 (WebGL untouched, opt-in preserved). MSAA-4 default is visual policy (Rule 1) — any slice flipping it without recorded sign-off is reverted on sight. |

**Arch-seeds (`C11-SEED-23..26` + the cross-cluster seeds; G10 §A4–A7).** Recorded so the Gate-D
verdict can point at them; none C11-schedulable without its own gate: `C11-SEED-23` S1-6 frame-delta
retained-commandList tier (the register's contradiction #3 — without it backend wins cannot deliver
≥2× at p95 on CPU-bound hosts; unblocks `C11-63` and S1-1); `C11-SEED-24` worker-renderer
productization (the ONLY shipped mechanism that raises the main-thread CPU ceiling — benchmark lane
first); `C11-SEED-25` S5-2 WASM consume-or-retire (5/7 bridges dead, Principle-7 per-bridge
disposition, no silent deletion); `C11-SEED-26` NEW-VEGETATION-SYSTEM; plus the P3 content/perf seeds
`C11-SEED-01..22` in their clusters (§1). `C11-77` geometry-residency dedupe is dossiered as G10 §A7
(gated on the typedArray-release policy) though it carries a schedulable number in `submit-residency`.

---

## 7. The 3 maintainer decisions + consolidated cross-guide OPEN QUESTIONS

### 7.0 Maintainer decisions RESOLVED at the 2026-07-18 `C11-00B` sweep (maintainer-final)

These were ratified maintainer-final on 2026-07-18 and are now SCHEDULED (no longer
BLOCKED-ON-MAINTAINER). All are bound by the §2 ★ GOVERNING PRINCIPLE — never remove an additive WebGPU
capability for parity; change the default + keep a toggle.

- **OIT translucent-primitive wiring → FULL wiring** (`C11-157`, TOP of W1; primitive→collection→model).
  Silhouette body-wash (`C11-91`) → **replicate WebGL**, folds into `C11-157`. MRT-OIT default-off stays
  FAR-003-contained (7.1 #3 RESOLVED to "fund the wiring", not a metric flip).
- **Enhanced-ocean → TRUE PARITY** (`C11-158`): default **classic** water; the enhancement becomes an
  opt-in **TOGGLE** via a new `ENHANCED_OCEAN` define ⇒ **`C11-149` define-width is a HARD PREDECESSOR**;
  land jointly with the OPEN `water-bugs-2026-07-06` fix (7.1 #2 RESOLVED).
- **Parity sweep (default-parity + keep toggle, never remove):** night-lights → default **OFF**
  (`C11-159`, toggle stays); sunBloom → **WIRE** to WebGPU PP Bloom/LensFlare (`C11-160`); empty-scene
  background-color → **FIX** (`C11-17`); AutoExposure always-on compute → **DEMAND-GATE** the dispatch +
  **ratify the HDR altitude-gate** (`C11-161`); `usePostProcessSelected` hardwired false → **PORT** the
  selected path (`C11-162`).
- **Sun blend mode** (`C11-115`) → WebGPU **ALPHA_BLEND** (match WebGL).
- **Reversed-Z** → run the `C11-GT-01` measurement spike **EARLY in W1** (measurement-only; the slice
  work `C11-GT-02` stays gated §6).
- **Exit gate** → **BOTH**: certify/close on the deterministic `C11-137` C8-contract gate (truthful
  counts); ALSO run the full real-scene suite when a real adapter is available (recorded follow-up, not
  a close-blocker).
- **Orchestrator mode** → **DEFAULT** (G10 Q3 resolved; the ×5-hardened engine-script fallback stays a
  reserve).
- **`forceSceneMRT` default-flip** → requires an **EXPLICIT recorded maintainer sign-off** (like the
  `C11-GT-03` reserve-lever protocol), NOT standing DW-phasing approval (G3 Q3a resolved). Governs
  `C11-43` P2.
- **CLOUD-U4** (`C11-126`) → option **(A): Scene owns a managed default VOLUMETRIC CloudCollection**
  (re-point the 4 producers); renderer gates are mechanical once chosen.
- **High-density / `gpuCullingHint`** (`C11-11`) → **diagnose first** (W1 diagnosis), then a **lean
  repair** — do NOT degrade the feature for the metric; if it traces to the contained GPU-cull path,
  surface per the charter (§2 rule 1).

**Still-deferred after this sweep:** the splat-data-producer placement + offline asset (7.1 #1, still
BLOCKED-ON-MAINTAINER); FAR-107 public pick-API review (`C11-07`); declutter displacement-threshold
default (`C11-66`); C9-01 Gate-A closure (`C11-145`) + gate-F baseline refresh (`C11-147`); rte-taa +
clouds-weather guide commissioning; benchmark-lane workload-file identity (`C11-64`); the absent 2D perf
lane (`C11-59`); **and the 4 CELESTIAL sub-decisions below.**

**The 4 `C11-163` CELESTIAL-WATER-REFLECTION sub-decisions (deferred to when the epic is scheduled):**

1. **Target ocean:** (A) globe water-mask "enhanced ocean" (`computeEnhancedOcean`, the default shipping
   path) vs (B) opt-in FFT `OceanSurface.wgsl` (cleaner prototype host). Dossier §1 recommends prototype
   in (B) → port to (A).
2. **Parity stance:** (i) declare it a WebGPU-only enhancement (`FEATURE_INVENTORY §B`, no GLSL twin —
   consistent with `ProceduralClouds` precedent) vs (ii) ship a reduced moonglade-only GLSL twin for the
   enhanced ocean. Dossier §6 recommends (i).
3. **Star source:** S3 (a) bake a star-catalog cubemap / (b) procedural hash star field / (c) reuse the
   atmosphere IBL cube / (d) expose the existing SkyBox Tycho cubemap. Dossier §4 favors (d) or (b) for a
   first cut.
4. **Cloud-occlusion fidelity:** S5a cheap (reuse the existing sun-view beer-shadow-map) vs S5b accurate
   (bake a second moon-view beer-shadow-map). Dossier §2.4 recommends S5a first, S5b as a follow-up.

### 7.1 The 3 named maintainer-decision items (BLOCKED-ON-MAINTAINER)

> **2026-07-18: #2 (enhanced-ocean) and #3 (OIT-wiring) are RESOLVED — see §7.0. Only #1 (splat) remains
> BLOCKED-ON-MAINTAINER.**

1. **Splat-data-producer (`C11-26`).** Placement — a WebGPU branch in `GaussianSplatPrimitive.update`
   pre-FR-return (scene-logic-extractor) vs inside the FR — AND the offline asset: vendor a
   license-clean `.spz`/glTF-splat tileset vs build a faithful synthetic builder. Both need a recorded
   maintainer decision before the producer brief is cut (G5 Q1). Blocks `C11-18`, `C11-105`,
   `C11-IC-02`.
2. **Enhanced-ocean default direction (defaults-parity D1, G8 — a `C11-00B` intake item, NOT a
   numbered register row).** NOT a clean flip: at HEAD it is uniform-driven with **no `ENHANCED_OCEAN`
   ShaderDefine**, so flipping the JS default does not yield WebGL parity. Two-part ask: **(A)** add a
   define-gated classic-vs-enhanced toggle with a verified GlobeFS `//>>else` (needs a free registry
   bit → `C11-149` define-width), then **(B)** ratify the default look. Must land jointly with (or
   after) the OPEN `water-bugs-2026-07-06` fix so the ratified default isn't a buggy one (G8 Q1).
3. **OIT translucent-primitive wiring (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` — Batch-700
   fallout, `C11-00B` intake item).** The real prerequisite the OIT NO-GO surfaced: no primitive/model/
   collection produces a `Pass.TRANSLUCENT` command carrying `_shaderCode`/`_oitPipeline`, so
   `hasOITPipelines` is always false and MRT-OIT is unreachable for standard translucency. Wiring
   translucent-primitive OIT pipeline variants is a multi-batch effort; MRT-OIT default-off stays
   RATIFIED FAR-003 containment — the maintainer decides whether to fund the wiring, not whether to
   flip a metric.

### 7.2 Consolidated cross-guide OPEN QUESTIONS (all G1–G10, deduped)

> **2026-07-18: several of the bullets below were RESOLVED at the `C11-00B` sweep — see §7.0**
> (`forceSceneMRT` sign-off protocol, sun-blend direction, sunBloom direction, HDR AutoExposure
> altitude-gate, CLOUD-U4, high-density `gpuCullingHint` policy, exit-gate criterion, orchestrator-mode).
> The bullets that REMAIN OPEN: FAR-107 public pick-API review, declutter displacement-threshold default,
> C9-01 Gate-A closure + gate-F baseline refresh, rte-taa/clouds-weather guide commissioning,
> benchmark-lane workload identity, the absent 2D perf lane, define-width sequencing, the
> checkpoint-attribution gates, and the reversed-Z reconciliation read.

**Maintainer decisions (beyond the 3 above):**

- **`gpuCullingHint='always'` policy (G1 Q4):** if the high-density-spheres drift (`C11-11`) traces to
  the contained GPU-cull path, the charter forbids degrading the feature for the metric — options are
  (a) repair the `'always'` path (possibly M–L, FAR-003-contained) or (b) re-scope the scene with an
  explicit coverage-loss note (needs sign-off). Flag early at B1 Step-2.
- **`probe-pickposition-webgpu` lane ruling (G1 Q2):** ratify `PROBE_BASE=http://localhost:8080` +
  `node server.js` + `Build/CesiumUnminified` as the supported reproduction of record for `C11-01`.
- **FAR-107 public pick-API review (G1 Q5):** `C11-07` requires maintainer approval on the public pick
  types before landing, or it stalls done-but-unlandable.
- **`forceSceneMRT` default-flip sign-off protocol (G3 Q3a):** does the maintainer want an explicit
  recorded sign-off like the `C11-GT-03` reserve-lever protocol, or does the DW-recorded phasing count
  as standing approval? Governs `C11-43` P2.
- **Stencil-less depth half of `C11-48` sub-slice (G3 Q3c)** — wanted before reversed-Z resolves? May
  be throwaway if `C11-GT-02` activates (same D24S8 surface).
- **S6-4 repair-vs-retire (G3 Q3b, Principle-7):** recommendation REPAIR (a genuine correctness bug in
  `C11-48`).
- **Model-silhouette translucent body-wash-vs-rim (`C11-91`, G5 Q2):** replicate WebGL's OIT-stencil
  body-wash artifact for byte-parity, or ratify WebGPU's documented rim-only intent.
- **Sun-blend-mode direction (`C11-115`, G8 §B3):** WebGPU flare → ALPHA_BLEND matching WebGL, or
  ratify additive + retune WebGL. Sequences ahead of the sunBloom parity question.
- **sunBloom parity direction (G6 Q2a / G8):** wire a WebGPU screen-space glare (default-pixel change,
  needs ratification) vs ratify the baked substitute.
- **HDR AutoExposure altitude-gate ratification (G6 Q2b):** behavior kept, policy record missing.
- **ADR accumulation complete-vs-retire (`C11-107`, G6 Q2d):** retire needs explicit Principle-7
  sign-off.
- **CLOUD-U4 architectural decision (`C11-126`):** (A) Scene/Globe owns a managed default VOLUMETRIC
  CloudCollection re-pointing 4 producers, or (B) remove/re-home the globe cloud config sink. Renderer
  gates are mechanical once chosen.
- **Declutter displacement-threshold default (`C11-66`, G7 Q2):** opt-in (default 0 = today) needs no
  approval; a nonzero default needs sign-off.
- **C9-01 Gate-A closure (`C11-145`, G9 Q5) + gate-F baseline refresh timing (`C11-147`)** are
  maintainer-decision rows.
- **Exit-gate criterion (G9 Q1/Q2):** confirm "campaign certifies = `C11-137` closes green with
  truthful counts"; and whether the "spec green" bar is the focused/unit lane (deterministic) with the
  real-scene lane truthfully counted, or the full real-scene suite must hold a headless session (may
  need a real adapter the sandbox lacks).

**Sequencing / dependency questions:**

- **C10 completion state at launch (G1 Q1, G2 Q1/Q2, G3 Q1, G5 Q3/Q4, G9 Q3):** the schedulable set of
  the pick cluster, the terrain family, the boot triad, and the define-width chain is indeterminate
  until `C11-00B` reads the live C10 `results[]`. Freeze wave assignments only after.
- **Reversed-Z reconciliation (G1 Q7, G3 Q1b, G6 §1001, G8 Q6):** if `C11-GT-01` recorded GO, every
  log-depth-expanding item (`C11-IC-01` pick fleet, `C11-131` planar-reflect ocean depth, the RGBA8
  pack optimizers `C11-45`/`C11-46`) needs the recorded reconciliation read first — the single biggest
  strategic hazard.
- **Define-width spend (G2 Q5, G5 Q3, G8 Q6):** `C11-149` (C10-08b) must sequence before ANY new
  define bit; several items (`C11-92`, `C11-88`, `C11-89`, `C11-81`, `C11-131`) fan out on it.
- **Checkpoint-attribution gates (G2 Q1, G4 Q1, G7 Q6, G8 Q5):** `C11-27` (C9-17 Slice D), the S10 L
  slices, and `C11-113` (atmosphere march) open only if Gate-D / recorded C9-30 attribution names their
  cost. Confirm the C9-30 PROMOTE attribution suffices, or wait for `C11-GATE-D-CHECKPOINT`.
- **2D perf lane absent (G4 Q4):** `C11-59` (S1-5/S7-6) cannot make route-p95 claims without a 2D
  moving lane in `run-performance-campaign.mjs` — add the lane (could ride `C11-64`) or accept
  counter-evidence-only landings.
- **Benchmark-lane workload-file identity (G7 Q1):** put the entity lane in a SEPARATE
  `performance-workloads-entity.json` with its own set id (preserves checkpoint comparability) vs a
  bumped id — decide before `C11-64`.
- **rte-taa + clouds-weather have NO cluster guide:** commission a guide (or a detailed brief pack)
  before opening `C11-52` (W5) and `C11-124` (W7). Surfaced as a planning gap.
- **Doc-hygiene reconciliations to fold into whatever lands first (G1 Q8, G5 Q7/Q8, G6 Q3, G8 Q4,
  G9 Q4):** `WebGPUComputePipelineCache` exists; `WebGPUModelRenderer` already `.ts`; `scene.pickVoxel`
  no longer throws; SHADOW-LAYOUT-QUANTIZED likely doc-close; KHR_materials_variants may be §D FUTURE
  not a parity gap (needs an upstream check). The W1 reconciliation slice owns these.
- **Orchestrator-mode vs engine-script (G10 Q3):** whether C11 runs in orchestrator mode (default) or
  forks the ×5-hardened engine script (G10 §B7) for an unattended run — a maintainer call depending on
  whether a human is at the wheel.

---

## 8. Pointers

- **Operating charter + takeover manual + salvage playbook + engine-script fallback:**
  `campaign11_planning/guides/G10-charter-mechanics.md` (authoritative for mechanics).
- **Execution index (cluster→guide→C11-id cross-map + read-your-guide instruction):**
  `CAMPAIGN11_EXECUTION_GUIDE.md`.
- **Item universe:** `campaign11_planning/CANDIDATE_REGISTER.md`. **Cluster guides:**
  `campaign11_planning/guides/G1..G10`. **Planning status:** `campaign11_planning/_PLANNING_STATUS.md`.
- **Defaults-parity feed:** `DEFAULT_PARITY_MATRIX_2026-07-18.md`. **C10 structure exemplar:**
  `QUEUE_2026-07-16_CAMPAIGN10.md`. **Runner:** `Tools/visual-regression/run-performance-campaign.mjs`
  (`moving-camera-altitude-track-3d`, 8 segments, near-ground idx 5+6).
