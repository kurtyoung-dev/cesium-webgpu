# QUEUE 2026-07-04 — CAMPAIGN 3 (Opus run)

> **BANNER: input to the `campaign-3-opus` workflow engine** (`.claude/workflows/campaign-3-model-tiered.js` lineage; final Opus build run inline).
> Model-tiering is wired into the engine (`t.model` / `t.auditModel` per task), but **this run is ALL-OPUS** — Fable 5 capacity was exhausted mid-reland (2026-07-04). The `auditModel: fable` overrides were stripped; the tier infra stays in-engine for the next Fable-available run.

- **HEAD at launch:** Batch 530 (`ae2f4630c5`).
- **Source:** the 2026-07-04 remaining-work audit (~110 open items) + the canonical docs (ROADMAP_AND_DEFERRED_WORK / ISSUES_AND_FIXED_BUGS / DEFERRED_WORK carry per-ID evidence).
- **Engine contract per task:** premise-verify -> implement -> build -> probe (READ PNGs) -> off-gate -> adversarial audit -> auto-fix loop -> land, with clean-tree contracts + the two hardening fixes (offByteIdentical GO-escape for unconditional bug-fixes; audit-retry-on-death before revert).

## Carried-over from the reland run (Fable-credit casualties, now Opus)

The v1.143/reland run landed 21+2 batches; two model-projectTo2D tasks were unfinished when Fable capacity ran out — they lead this run:

| ID | Effort | Deps | Model | Title |
| --- | --- | --- | --- | --- |
| `NEW-MODEL-PROJECT2D-BV-MORPH` | M | — | opus | Model projectTo2D 1/2: 2D-clipped ortho bounding-volume morph + probe |
| `NEW-MODEL-SCENE2D-IDL-DUPLICATE` | M | NEW-MODEL-PROJECT2D-BV-MORPH | opus | Model projectTo2D 2/2: SCENE2D IDL-crossing duplicate command + per-primitive 2D BVs |

## Campaign 3 (25 items)

| # | ID | Effort | Deps | Model | Title |
| --- | --- | --- | --- | --- | --- |
| Q1 | `Q1-KTX2-TRANSCODER-FORMATS` | S | — | opus | ROADMAP s3 #1/s4 |
| Q2 | `Q2-VECTOR3DTILE-MSAA` | M | — | opus | ROADMAP s4 |
| Q3 | `Q3-COLLECTIONS-SCENE2D-ALLZERO` | L | — | opus(inherited) | DIAGNOSTIC |
| Q4 | `Q4-KHR-UNLIT-BLACK` | M | — | opus(inherited) | DIAGNOSTIC |
| Q5 | `Q5-TIMEDYNAMIC-POINTCLOUD-ZERO` | M | — | opus(inherited) | DIAGNOSTIC |
| Q6 | `Q6-KTX2-IBL-CUBEMAP` | M | Q1-KTX2-TRANSCODER-FORMATS | opus | ROADMAP s4 |
| Q7 | `Q7-PROBE-DETERMINISM` | M | — | opus(inherited) | METHODOLOGY |
| Q8 | `Q8-IBL-PAIR-BISECT` | M | — | opus(inherited) | DIAGNOSTIC |
| Q9 | `Q9-STARFIELD-SPACE-BUCKET` | M | — | opus(inherited) | DIAGNOSTIC |
| Q10 | `Q10-DAYTIME-OCEAN-BRIGHTNESS` | M | — | opus(inherited) | DIAGNOSTIC |
| Q11 | `Q11-RIVER-WATER-INTENSITY` | S | — | opus | DEFERRED_WORK PARITY-GLOBE-RIVER-WATER-INTENSITY |
| Q12 | `Q12-EXAG-WATER-STREAKS` | M | Q11-RIVER-WATER-INTENSITY | opus(inherited) | DIAGNOSTIC |
| Q13 | `Q13-PLAIN-HDR-GAMMA-CORE` | L | — | opus(inherited) | EPIC increment 1 |
| Q14 | `Q14-HDR-TOGGLE-INVALIDATION` | M | Q13-PLAIN-HDR-GAMMA-CORE | opus | EPIC increment 2 |
| Q15 | `Q15-VECTOR3DTILE-CONTAINMENT` | M | Q2-VECTOR3DTILE-MSAA | opus | ROADMAP s4 |
| Q16 | `Q16-WGF1-CLIP-DISTANCES` | M | — | opus | ROADMAP s4 |
| Q17 | `Q17-LOGDEPTH-POINTCLOUD-SPLAT` | M | — | opus | ROADMAP NEW-LOG-DEPTH-REMAINING-PRODUCERS: standalone WebGPUPointCloudRenderer |
| Q18 | `Q18-LOGDEPTH-CONSUMERS` | M | Q17-LOGDEPTH-POINTCLOUD-SPLAT | opus | ROADMAP NEW-LOG-DEPTH-REMAINING-CONSUMERS: off-by-default depth readers |
| Q19 | `Q19-ELLIPSOID-RTE` | M | — | opus | ISSUES s3 |
| Q20 | `Q20-EDGE-LINESTRINGS` | M | — | opus | ROADMAP NEW-EDGE-LINESTRINGS-EXPLICIT: explicit lineStrings edges yield ZERO WebGPU edges |
| Q21 | `Q21-METADATA-INSTANCE-SOURCE` | M | — | opus | ROADMAP PARITY-METADATA-TABLE-INSTANCE-SOURCE: property tables keyed by INSTANCE-sourced feature IDs |
| Q22 | `Q22-VOXEL-OCTREE-L3PLUS` | M | — | opus | ROADMAP NEW-VOXEL-OCTREE-DEEP-LEVELS: traversal capped at level 2 |
| Q23 | `Q23-AERIAL-FROXEL` | L | — | opus | ROADMAP s3 #3 + s9 |
| Q24 | `Q24-DP-H47-ATMOSPHERE-UNIFORMS` | L | — | opus(inherited) | EPIC |
| Q25 | `Q25-CUSTOM-SHADER-API-GAP` | M | — | opus(inherited) | PREMISE-VERIFY FIRST |

## Tiering rationale (for the next Fable-available run)

- **Opus-appropriate (recipe carries the answer):** the KTX2 pair, Vector3DTile MSAA + containment, WGF-1 clip-distances, log-depth producer/consumer, ellipsoid-RTE, edge lineStrings, metadata instance-source, voxel octree L3+, aerial froxel, HDR-toggle invalidation, and both projectTo2D tasks.
- **Fable-appropriate (agent must FIND the answer) — running on Opus this pass:** the SCENE2D-collections/KHR-unlit/TimeDynamic-pointcloud diagnostics, the determinism kit + IBL-pair bisect + starfield residual, daytime-ocean + exag-water, the plain-HDR-gamma core epic, DP-H47 shared atmosphere uniforms, and the CustomShader API-gap audit.

**Total: 27 tasks** (16 explicit-Opus, 11 inherit-session=Opus).

