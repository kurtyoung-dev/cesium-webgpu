# Current Rendering Functionality Baseline

Date: 2026-07-13

Status: **PHASE-0 CHARACTERIZATION ANCHOR — CURATION IN PROGRESS**

Code anchor: `a54cc06b2aad89a00e8ecb0887b953a36f061954` (includes the landed Campaign-7 B636-B654 feature work and the later research-register commit).

Purpose: preserve what the fork can do before architecture/performance fixes begin, without promoting stale diagnostics or known artifacts into accepted behavior. This document is the human-readable companion to the remediation ledger and FAR-002 manifest.

## Evidence hierarchy

1. Public/API expectations come from `FEATURE_INVENTORY.md`, upstream compatibility, and targeted specs.
2. A locked historical image is accepted only when its producer probe, renderer, flags, code commit, camera/time/assets, semantic oracle, and current-HEAD reproducibility are known.
3. `Tools/visual-regression/output` is valuable characterization evidence, but it is ignored and contains experimental, failed, restored, stale, and reverted captures mixed together.
4. Semantic assertions, GPU/console error gates, pick results, resource counters, and default-off/restored checks remain required even when an image looks correct.
5. Candidate WebGL must compare with historical WebGL, candidate WebGPU with historical WebGPU, and candidate WebGL with candidate WebGPU. Cross-backend diff alone is insufficient.

## Corpus inventory at launch

- 2,934 images total: 2,932 PNG and 2 JPG.
- 2,879 images under `Tools/visual-regression/output`.
- 596 Node `.mjs` files, including 593 top-level probes.
- 154 images were captured on 2026-07-11 and 104 on 2026-07-10.
- `scenes.json` defines seven formal cross-backend scenes.
- The tracked `baseline` directory contains only two WebGL/WebGPU pairs plus one standalone reprojection image; it is not a complete historical gate.
- `output/report.json` is overwritten by subset runs. At launch it records only `globe-default`, mismatch `0.4554%`, with a clean armed WebGPU error gate.

## Core formal scenes

All paths below are under `Tools/visual-regression/output`; each stem has `.webgl.png`, `.webgpu.png`, and `.diff.png` captures from 2026-07-10.

| Scenario | Preserved behavior | Launch mismatch | Baseline state |
| --- | --- | ---: | --- |
| `globe-default` | Default globe, imagery, terrain, atmosphere, canvas composite | 0.4554% | Candidate accepted-current |
| `globe-zoomed-mountain` | Terrain LOD, imagery filtering, lighting | 0.4590% | Candidate accepted-current |
| `globe-horizon` | Low-angle atmosphere, fog, stars, depth precision | 0.6874% | Candidate accepted-current |
| `wgs84-orbit` | WGS84 orbit-scale precision and ground atmosphere | 0.6418% | Candidate accepted-current |
| `wgs84-close` | WGS84 close precision and near terrain | 0.4544% | Candidate accepted-current |
| `mid-distance-12mm` | Lighting-fade and mid-distance atmospheric drape | 0.7038% | Candidate accepted-current |
| `high-density-5k-spheres` | 5K instances, culling/HiZ thresholds, command density | 8.5805% | Characterization/red; do not promote as parity golden |

## Extended functionality witnesses

These are the best recent representations of the current feature surface. Exact files remain characterization until the FAR-002 manifest verifies provenance and reproduces them from a clean anchor build.

| Subsystem | Representative current evidence | Regression contract for fixes |
| --- | --- | --- |
| Globe, imagery, terrain, water | `lake-mask-{base,off,on}-*-{webgl,webgpu}.png`; `probe-coast-aa-{before,after}-{webgl,webgpu}.png`; `fft-ocean-ctx-on-t2.png`; formal globe scenes | Preserve default globe/imagery, terrain LOD, reprojection, water-mask/coast behavior, and FFT-ocean enabled plus default-off/restored states. Flyovers also gate residency and hot-path preparation. |
| Atmosphere and celestial | `probe-sun-stars-extinction-*.png`; `probe-moon-atmosphere-{webgl,webgpu}-*.png`; `sky-coeffs-{webgl,webgpu}-{base,skyover,atmoover}.png` | Preserve horizon/orbit color, sun/star extinction, moon/sky coefficients, poles/antimeridian/RTE, and user-parameter resolution. |
| 3D Tiles, Models, splats, voxels | `model-mrt-a-ao-off-def-off.png`; `splat-occlusion-default.png`; `splat-sort-near.png`; `probe-tileset-capture-*.png`; `probe-voxel-cell-pick-*-{webgl,webgpu}.png` | Preserve glTF/PBR/3D-Tiles variants, capture, model MRT, splat occlusion/sorting, voxel display/picking, metadata, scene modes, and no duplicate resource realization. |
| Classification and materials | `classifier-{SCENE3D,SCENE2D,COLUMBUS_VIEW}-{webgl,webgpu}.png`; `gptc-{Color,Stripe,Checkerboard,Grid,Image}-{webgl,webgpu}.png`; `classprim-{webgl,webgpu}.png` | Preserve flat/textured GroundPrimitive and ClassificationPrimitive semantics, target selection, scene modes, picking, depth, and material mutation. |
| Collections and geometry | `polyline-multimaterial-{webgl,webgpu}.png`; `polyline-material-{webgl,webgpu}-*.png`; `high-density-5k-spheres.*.png`; collection/pick probes | Preserve Billboard/Label/Point/Polyline/Cloud/BufferPrimitive output, ordering, scene modes, sparse mutation, atlas behavior, RTE, and pick IDs while eliminating settled rebuilds. |
| Post-process, log depth, HDR | `pp-library-builtins/`; `pp-silhouette-array/`; `logdepth-pp-sliceb-*.png`; `logdepth-pp-slicec-*.png`; `ssgi-*.png`; `tpdf-dither-{off,on}.png`; `motion-blur-{off,on-small,on-large}.png` | Preserve post-stage ordering, canvas blit, log-depth consumers, HDR/tonemap, silhouette arrays, SSGI, dither, and motion-blur on/off/restored behavior. |
| Lighting and shadows | `cloud-shadow-cascades/{baseline,cascade,noshadow,plainterrain}.png`; `ltc-area-{off,on,offgate}.png`; model MRT evidence | Preserve CSM/cloud-shadow topology, LTC area-light enabled/off-gate behavior, material lighting, and no new depth or attachment errors. |
| Point clouds and compute effects | `pointcloud-logdepth-{webgl,webgpu}.png`; `probe-flowfield-{baseline,off,on-early,on-late}.png`; high-density formal scene | Preserve point-cloud depth/EDL behavior, flow-field state evolution and off/restored state, compute thresholds, and renderer fallback semantics. |
| Clouds and weather | `stbnlod-*.png`; `mammatus-*.png`; cloud-shadow evidence | Preserve volumetric cloud LOD, temporal behavior, morph/weather integration, shadowing, and default-off/restored states. `lightning-*.png` remains reverted-or-unknown until a current producer is found. |
| Picking, modes, multi-context | voxel/model/point pick probes; `probe-mode-roundtrip.mjs`; `probe-webgpu-reinit-switch.mjs`; split-screen comparisons | Preserve synchronous WebGL behavior, authoritative async WebGPU results, 3D/2D/CV/Morph, renderer switching, split contexts, pooled-device isolation, resize, destroy, and device-loss behavior. |

## Visually inspected launch samples

The following newest images were opened and inspected during Phase 0:

- `output/fft-ocean-ctx-on-t2.png`
- `output/model-mrt-a-ao-off-def-off.png`
- `output/cloud-shadow-cascades/cascade.png`
- `output/ssgi-on.png`
- `output/logdepth-pp-sliceb-baseline.png`
- `output/motion-blur-on-large.png`
- `output/sky-coeffs-webgl-base.png`
- `output/sky-coeffs-webgpu-base.png`

They confirm a broad current feature surface, but also show why newest does not mean golden: the set includes diagnostic FFT output, visible SSGI striping, extreme motion-blur framing, and feature-isolation images that are unsuitable as general parity references.

## Known corpus limitations

- The current harness compares current WebGL with current WebGPU but does not load historical images during a normal run. A shared-core regression can pass.
- Renderer labels, timing text, and other deterministic UI overlays are not masked consistently and can consume mismatch budget.
- Dynamic imagery, pipeline readiness, tile settle, and temporal effects need semantic readiness gates; a fixed rAF count is not enough.
- Several recent captures expose known differences or artifacts, including classification opacity, lens-flare populations, point-cloud/log-depth output, SSGI striping, and the 5K-instance mismatch. These are red/characterization evidence, not behavior to preserve as correct.
- Network/Ion-dependent scenes are integration evidence only. Blocking images must use fixed local assets or pin complete asset/service identity.

## Promotion checklist

Before an image becomes a blocking historical baseline, FAR-002 records:

1. image SHA-256, dimensions, mtime, and renderer;
2. producer probe and exact scenario/flags;
3. candidate commit and dirty-state declaration;
4. browser, OS, adapter, device features/limits, viewport, and DPR;
5. fixed camera, clock, seed, assets, and readiness condition;
6. semantic/API oracle and GPU/console error result;
7. expected WebGL/WebGPU differences and separate historical/cross-backend tolerances;
8. manual visual-review disposition and written rationale;
9. enabled and default-off/off-restored images for opt-in features;
10. confirmation that a current clean build reproduces the artifact.

## Per-fix regression rule

Every functional FAR package identifies its affected rows in the matrix before editing. It adds or selects a red/characterization fixture, captures pre-change WebGL and WebGPU, applies the fix, runs the semantic/API/resource gates, captures post-change images, and visually inspects them. Baselines are updated only when the behavior change is intentional and separately justified.

Instrumentation-only changes, including the first timestamp-profiler repair, must leave images unchanged. They still run the touched core smoke scenes and assert resolved renderer, no GPU/console errors, and correct profiling capability/config/active state.

## Remediation checkpoint status

The first-tranche implementation work does not promote or replace this launch anchor. As of the current 2026-07-13 worktree checkpoint:

- the historical baseline is **NON_CERTIFYING** because a curated, renderer-specific historical corpus has not been approved;
- targeted WebGL/WebGPU semantic, current-parity, allocation, timestamp, TAA, GPU-sort, and focused browser gates are implementation evidence only;
- the compatibility-buffer probe establishes zero production compatibility native `GPUBuffer` allocations, but legacy CPU/WebGL-shaped shells remain and other compatibility resource families are outside that result;
- bounded model geometry/metadata caches are present, while producer-wide mutable metadata invalidation still requires an explicit revision contract;
- the final coordinated build, post-integration TypeScript run, and 384-case affected Edge matrix pass;
- the strict allocation and TAA probes pass, and a complete one-run/30-frame settled WebGL/WebGPU workload artifact is recorded at `output/performance-settled-final.json`;
- release certification remains blocked by the non-certifying historical corpus, the unrestricted network-dependent full/visual runners, repeated counterbalanced performance cells, and the remaining architecture packages.

Accordingly, a formal scene that stays within its current parity threshold is encouraging but cannot alone prove the absence of a same-direction regression in both renderers. No post-remediation image is a new golden until it completes the promotion checklist above.
