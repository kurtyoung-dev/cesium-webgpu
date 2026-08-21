# Tooling Catalog — the .mjs library census

**Generated 2026-08-15** from the 16-agent library audit (workflow wf_4bd1e36c-65f: 14 classification readers over docstrings + git freshness + a full cross-reference map, one cross-file analyst, one decisions memo). **This is the everything-view**: every .mjs under Tools/ and scripts/. The curated how-to-debug view stays in DEBUGGING_GUIDE.md. Regeneration: currently by re-running the audit recipe; a header-driven node generator is proposed under ruling M2 below.

Status legend: **ACTIVE** in service; **INVESTIGATION_ARTIFACT** one-off diagnostic, conclusion banked elsewhere; **LIKELY_SUPERSEDED** newer sibling covers it (named); **BROKEN_STALE** references engine hooks verified absent; **DELIBERATE_RED_FLAG** intentionally failing as a standing flag — untouchable; **HELD_FOR_D8** frozen under HANDOFF_2026-08-14_CODEX_PAUSE (snapshot at audit time); **UNKNOWN** honestly unclear.

| Metric | Value |
|---|---|
| Total files | 1012 |
| ACTIVE | 799 |
| INVESTIGATION_ARTIFACT | 186 |
| HELD_FOR_D8 | 9 |
| LIKELY_SUPERSEDED | 8 |
| BROKEN_STALE | 8 |
| DELIBERATE_RED_FLAG | 1 |
| UNKNOWN | 1 |
| Classes | probe 675, spec 172, gate-lib 48, lib 45, other 24, bake-tool 16, runner 14, scratch 12, fixture 6 |
| DEBUGGING_GUIDE coverage at audit | 49/1012 unique files (~5%) |
| Ghost doc mentions (documented, nonexistent) | **0** — the audit-time "4" was an oracle artifact (`git ls-files` vs disk): the four names are untracked Lane-F probes that exist on disk and are ACTIVE in this census; corrected 2026-08-16 under ruling M2 |

---

## Analyst report (family map, supersession chains, archive candidates, coverage gaps, org proposal)

Verification notes before the deliverables: I spot-checked the supersession pairs by reading file heads (`diff-two-pngs` vs `diff-fog-ms` confirmed same function, general tool adds crop + zero-drift exit), and verified all seven BROKEN_STALE classifications by grepping the engine for their hooks — `__FORCE_CONE`, `__dbgDrawCounts`, `__dbgGlobeTileTrace*`, `__dbgResolveGlobe`, `_globeImageryCache`, and the classifier "TEMP DIAG" encoding are all gone from `packages/engine/Source`. Key sizing numbers (measured, not estimated): **865** flat `.mjs` in `Tools/visual-regression/` + **74** in `lib/`; **541** unique `Tools/visual-regression/*.mjs` path strings referenced inside Tools/scripts/package.json/.husky; **488** unique paths referenced across `migration_doc/` (**470** excluding `migration_doc/archive/`), spread over **105** doc files; DEBUGGING_GUIDE references only **49** unique files.

---

## 1. FAMILY MAP

| Family (stem/subject) | ~Files | Durable core | Investigation tail |
|---|---|---|---|
| **cloud-\*** (C13) | ~95 (60 probes, 25 specs, 12 libs) | C13 spec fleet (`cloud-march-transfer`, `cloud-reconstruction-attachments`, `cloud-temporal-rte`, `cloud-density-domain`, `cloud-genus-morphology`, `cloud-observability-counters`, `cloud-tour-sequences`…), standing probes (`probe-cloud-planetary`, `-tour-sequences`, `-u2-perf`, `-empty-frustum`, `-shadows-polar`), `lib/cloud-*` | ~17 INVESTIGATION (V-series stash A/Bs: `-noisebake`, `-noisecore`, `-remap`, `-lighting`, `-cone-parity`, `-halfres-parity`, `-lut-parity`, `-shadows-parity`, `-tier-resolver`, `-u1-scaffold`, `-u2-config`, `-depth-occlusion`, `multideck-*` ×3) + 2 BROKEN_STALE (`-cone-equal`, `-cone-perf`) |
| **eclipse-\* / c12-29-s\*** | ~38 | S1–S6 specs, S5 gate triples (probe+gate-lib+spec ×6), `eclipse-globe-svs-oracle`, SVS-5073 fixture pair | Essentially none — youngest, most disciplined family. 3 files HELD_FOR_D8 (svs-footprint triple) |
| **moon-\*** | ~33 | 16 `moon-*.spec` (lifecycle/mip/phase/asset), 8 standing probes, 4 bake tools | `moon-albedo-bake/work/` — 5 scratch files (conclusion banked in `lunar-landmarks.mjs` + `moon-albedo-asset.spec`) |
| **celestial / star / sun / sky** (C12 gates) | ~45 | G1–G4 gate libs+specs, `celestial-capture-harness`, `solar-disc-model.spec`, `sun-halo-composition.spec`, `starfield-psf.spec`, skybox specs | `probe-sun-pixel-check`, `diag-stars-hdr-autoexposure`, `probe-ms-lut-azimuth`; 3 HELD_FOR_D8 (c12-11 trio) + 3 HELD_FOR_D8 (c12-31 aureole trio) |
| **polar / wgs84 imagery** | ~28 | `probe-polar-multi-plain`, `probe-globe-polar-stretch`, `probe-wgs84`, `probe-polar-diff-all`, `probe-reproject-baseline`, `probe-reprojected-texture-compare` | **Largest tail in the audit**: ~22 INVESTIGATION probes (`probe-polar-{alpha-debug,bisect,fixed-time,forcered,fs-stages,imagery-state,mesh-compare,multi-angle,noculling,pixel-sweep,settle,stretch-diag,wireframe}`, `probe-wgs84-{alphadbg,atmo,close-postfix,layer1-alpha,polar-stretch,postcomposite,quick,sample0,varyings}`, `probe-southpole-diag`, `probe-lod-case-paths`, `probe-source-mercator-compare`) — bug fixed, conclusions in WEBGPU_DEBUGGING_LOG |
| **model-\*** (glTF) | ~40 | 25 acceptance probes (color/silhouette/splitter/IBL/scene-modes/2D-IDL…), 12 specs (arena/lifecycle/topology/pick-demand) | `probe-model-capture-face-zoom`, `-mip-inspect`, `-mip-shimmer` (C10-05 evidence) |
| **pick-\*** | ~22 | `probe-pick-*` gates (basic/multifrustum/metadata/ray-async/position ×2), `webgpu-pick-*` specs, collection/voxel/model pick probes | `probe-c10-11-ddtd-hitrate` |
| **voxel + c11-13** | ~27 | 11 `probe-voxel-*` acceptances, lifecycle/policy specs, L3/L4 fixtures, c11-13 probe/lib/spec cluster | none notable |
| **weather** | ~20 | Gate-B probe fleet (`edr-mock`, `metar`, `wcs`, `ingest`, `channels`, `seam-poles`, `regional-tails`), `weather-*.spec`, pinning lib | `probe-confirm-inspector-sky` |
| **collections / billboard / polyline** | ~30 | `probe-collections-regression` (THE consolidated gate), partial-write/pick/morph gates, polyline appearance fleet | `probe-billboard-2d-debug`, `probe-collections-entity`, `probe-polyline-geodesic` (premise-refutation record), `probe-gp-*`/`verify-gp-*` GroundPolyline bring-up (~5) |
| **atmo / fog** | ~25 | `probe-atmo-*` acceptance fleet, `probe-fog-ms/temporal/ground-fog`, `ground-fog-band.spec` | `probe-fog-ms-toggle`, `probe-fog-state`, `probe-c9-14-ground-atmo-stage` |
| **logdepth** | ~12 | `probe-logdepth-{globe,payoff,pp-sliceb,pp-slicec}`, `mat-logdepth-encode-stash.spec`, family z-fight gates | 3 `apply-logdepth-*` codemods; `probe-logdepth-zfight` is **DELIBERATE_RED_FLAG — untouchable** |
| **clustered lighting** | ~12 | full `probe-cluster*` chain (bounds→assign→consumer→scenes) | none |
| **TAA / HDR / post-process** | ~28 | `probe-taa-*` (7), `probe-*hdr*` (8), pp-library/builtins/f16 gates | `probe-pp-effects-audit`, `probe-mrt-validation`, `verify-initial-hdr`, `probe-gamma-chain`, `probe-tonemap` (BROKEN_STALE) |
| **performance campaign** | ~14 | `run-performance-campaign.mjs`, 8 `lib/performance-*` + ledgers, `performance-workloads.spec`, c11-146/168/205 gate triples | `probe-perf-baseline`, `probe-request-render-asymmetry` |
| **canvas-black / bring-up era** | ~15 | `probe-magenta-clear` (kept diagnostic) | `canvas-black-{narrow,readback,trace}`, `canvas-format-probe`, `probe-sceneframebuffer`, `probe-direct-draw-fb`, `probe-fb-*` ×2, `probe-draw-calls`, `probe-draw-pipeline-labels`, `webgl-vs-webgpu-pixel-check`, `probe-split-screen`, `split-screen-debug` |
| **bloom** | ~8 | `probe-bloom-parity`, `webgpu-sun-bloom-mirror.spec` | 6 `probe-bloom-*` forensics variants (no-globe/no-msaa/no-pp/no-sky/side-by-side/tile-state) |
| **b3dm / 3D Tiles diag** | ~10 | `verify-b3dm-render`, `probe-b3dm-render-edge`, c11-205 cluster | `diag-b3dm-*` ×3, `probe-b3dm-noglobe`, `probe-c-r9-*` ×2 |
| **sandcastle runners** | ~8 | `cross-backend-sandcastle-runner` + `analyze-cross-backend-report`, `sandcastle-smoke` | `sandcastle-batch-66-*` ×3, `run-regression-sweep`, `probe-new-sandcastles` |
| **bake tools** | ~20 | eot20/geoid/lake-mask, moon ×4, skybox ×2, star-catalog, stbn ×5, svs-5073 shard | moon `work/` ×5 (counted above) |
| **gate infrastructure** | ~20 | C16 suite (8), landing-rules/pre-push-guard/verify-landing-compliance (+specs), `probe-fleet-contract` + allowlist, `provenance-markers`, `verdict-exit-gate`, `webgpu-error-gate` | none — this is the newest, most load-bearing layer |
| **orbital / sgp4 / compute-instance** | ~16 | sgp4 kernel/reference/validators, j2, 6 `probe-compute-instance-*`, `probe-orbital-*` ×4 | `probe-mainthread-encode-ceiling` (go/no-go spike, decision banked) |
| **one-shot codemods** | 8 | — | all 8 (`apply-logdepth-*` ×3, `batch-117/121-*`, `wire-*` ×2, `scripts/codemod-split-material-ubo`) |

## 2. SUPERSESSION CHAINS (evidenced)

1. **`diff-fog-ms.mjs` → `diff-two-pngs.mjs`** — CONFIRMED by reading both: identical Playwright canvas-decode pixel diff; `diff-two-pngs` adds bottom-crop + exit-0-iff-zero-drift and self-describes as "the byte-identity gate tool of the diff family." Zero live-doc references to `diff-fog-ms`.
2. **`diff-multideck.mjs` → `diff-two-pngs.mjs`** — same function at threshold 0, which is `diff-two-pngs`'s default contract. Zero live-doc refs.
3. **`probe-gpu-tex.mjs` → `probe-imagery-tex.mjs`** — `probe-gpu-tex` self-describes as an early attempt that "never reaches the per-device renderer instance"; `probe-imagery-tex` asserts a realized `GPUTexture` via the actual `_imageryTextureCache`. Zero live-doc refs.
4. **`probe-dp46a-metadata.mjs` → `probe-dp46b-metadata.mjs`** — a is the de-risk proof via debug stub; b proves the same property through the real generated-WGSL codegen path (and c/d/e/f extend it). DP-H46 epic is CLOSED (memory: 2026-06-30). Zero live-doc refs to dp46a.
5. **`probe-bufferpolygon-2dcv.mjs` → `probe-buffer-2dcv-parity.mjs`** — a is explicitly the *pre-fix baseline recorder* (expected-LARGE diff); b is the post-fix parity acceptance for the whole Buffer\* family. Once the fix landed, the before-image recorder is strictly historical. (1 live doc ref — repoint before archiving.)
6. **`probe-bufferpoint-positiondatatype.mjs` → `probe-buffer-integer-position.mjs`** — the former gates the warn-once *gap documentation* for unsupported integer encodes; the latter proves the decode support that closes that gap. Gap-gate is obsolete once support ships. (1 live doc ref.)
7. **`probe-classifier-textured-materials.mjs` → `probe-groundprim-textured-classify.mjs`** — same four textured materials, but the successor adds the GLOBE-pass readiness gate that kills the B595 race the older probe was subject to. (1 live doc ref.)
8. **`sandcastle-batch-66-runner.mjs` → `sandcastle-batch-66-final-runner.mjs`** — final is the post-F1/F2/F3 rerun of the same sweep; the batch's reports live only under `migration_doc/archive/sandcastle-batch-66/`. Note `-final-runner` still has ~20 refs, all in archived docs.
9. **`moon-albedo-bake/work/analyze.mjs` → `work/analyze2.mjs` → `lunar-landmarks.mjs` + `moon-albedo-asset.spec.mjs`** — analyze2 self-describes as a refinement of analyze's orientation question; the conclusion is banked in the dependency-free landmark checker and byte-pinning spec.
10. **One-shot codemods → their shipped output + guarding specs**: `apply-logdepth-*` ×3 → shipped WGSL + `mat-logdepth-encode-stash.spec` + `probe-logdepth-*` gates; `batch-117/121-*` and `wire-globe-mrt-normal` → shipped GlobeTerrain MRT + `probe-normalmap-gbuffer`/`probe-litmat-mrt`; `wire-flat-shaders-aerial-lut` → `probe-aerial-lut-primitive`; `codemod-split-material-ubo` → shipped UBO split. A codemod's product being in-tree is its supersession.
11. **Engine-evolution obsolescence (BROKEN_STALE, hooks verified absent)**: `probe-cloud-cone-equal`/`-cone-perf` (`__FORCE_CONE` gone), `probe-globe-tile-trace`/`probe-globe-timing` (`__dbg*` globals gone), `probe-trace-counts` (`__dbgDrawCounts` gone), `probe-imagery-format` (`_globeImageryCache` gone), `probe-logdepth-diag` (TEMP DIAG encoding gone), `probe-tonemap` (legacy shim + stage-state shape). No successor file needed — these cannot run against current engine.

Chains I considered and **dropped for lack of evidence**: `probe-volumetric-clouds` → cloud fleet (scout probe, but nothing proves the fleet covers its exact bright-pixel question); `capture-and-diff` predecessors (none listed); `probe-saved-view` (template, not superseded by its descendants).

## 3. ARCHIVE CANDIDATES (proposal only — deletion/move needs a maintainer ruling)

Excluded per hard rules: `probe-logdepth-zfight` (DELIBERATE_RED_FLAG), all 7 HELD_FOR_D8 files (c12-11 trio, c12-29-s5-svs trio pieces, c12-31 trio pieces, `probe-sky-aureole-anchor`, `probe-stars-catalog`), `sky-band-compare.mjs` (UNKNOWN). Note also: any probe on the **`probe-fleet-contract-allowlist` census must have its allowlist row removed in the same change** (the spec fails on stale rows), so archiving is a code-edit, not a pure `git mv`.

**HIGH confidence** (~35 files):
- 8 one-shot codemods (`Tools/apply-*` ×3, `batch-117/121-*`, `wire-*` ×2, `scripts/codemod-split-material-ubo`) — risk: none; product is in-tree and spec-guarded.
- 7 BROKEN_STALE probes (chain 11) — risk: none; verified unrunnable against current engine.
- `diff-fog-ms`, `diff-multideck`, `probe-gpu-tex`, `probe-dp46a-metadata`, `sandcastle-batch-66-runner` — risk: none; verified chains, zero live refs.
- `moon-albedo-bake/work/` ×5, `output/` scratch ×3, `split-screen-debug`, `quick-screenshot`, `temp-pbr` — risk: none; self-described scratch, conclusions banked.
- `probe-polyline-geodesic` — conclusion-banked (DP-H7 refutation recorded) — archive safe; risk: losing the refutation record's discoverability — keep the debug-log pointer.

**MEDIUM confidence** (~55 files):
- Polar/wgs84 tail (~22, chain in family map) — conclusion-banked in WEBGPU_DEBUGGING_LOG (polar-stretch fixed B350/B502-era); risk: this artifact class recurred twice; re-deriving a bisect harness is cheap but nonzero.
- Canvas-black/bring-up era (~12) — conclusion-banked (BUG-12/13/15 sentinels now permanent in engine); risk: device-loss debugging occasionally wants raw readback probes.
- Cloud stash-parity/V-series A/Bs (~15) — each was a landing gate for a specific landed batch (B432/434/436/437/443, V1–V5, U1/U2); conclusion banked in batch landings; risk: stash-based A/B recipes are worth keeping *one* exemplar of.
- Bloom forensics ×6, `diag-b3dm-*` ×3 + `probe-c-r9-*` ×2, `verify-batches-106-109`, `run-regression-sweep`, `sandcastle-batch-66-{final,end-of-session}-runner`, `verify-glb-*` ×2 — batch-scoped, conclusions in archived reports; risk: `-final-runner` has 20 refs in archived docs (path breakage is contained to archive/).
- Remaining INVESTIGATION probes with 0 live refs (`probe-align-test`, `probe-darkness-quant`, `probe-disk-*`, `probe-farcam-*`, `probe-h12-longsettle`, `probe-hello-sc-clean/-wgl`, `disable-skyatmo-*`, `earth-pixel-probe`, `bug-11-imagery-probe`, `probe-vec4-error`, `probe-wgsl-doctype`, `probe-shim-debug/-trace`, `probe-camera-*` ×2, `probe-czml-bytes`, `probe-empty-scenes`, `probe-enable-lighting-state`, `probe-reproj-log`, `probe-trans-scale`, `probe-tex-format`, `probe-skirts-test`, `probe-particle-no-fog`, `probe-northpole-angles`, `probe-overlay-compositing`, `probe-determinism-check`, `probe-webgpu-grey`, `translucent-classification-debug`, `probe-classifier-2d-renderpass`, `probe-classifier-extents-inspect`, `probe-classifier-logdepth-settle`, `probe-groundprim-extents`, `debug-ground-polyline-color`, `diag-exag-water-streaks-*` ×2, `diag-ktx2-ibl-shape`, `diag-taa-black`, `diag-stars-hdr-autoexposure`, `probe-large-lake-water`, `probe-mainthread-encode-ceiling`, `probe-perf-baseline`, `probe-backend-isolation`, `probe-request-render-asymmetry`, `probe-c10-02-style-economics`, `probe-c10-11-ddtd-hitrate`, `probe-c9-14-ground-atmo-stage`, `probe-csm-globe-receive-trace`, `probe-model-capture-face-zoom`, `probe-model-mip-*` ×2, `probe-tileset-capture-face-zoom`, `probe-scene-capture-cardinal`, `probe-blend-math-bisect`, `probe-mip-debug`, `probe-mipmap-check`, `probe-ms-lut-azimuth`, `probe-msaa-comparison`, `probe-globe-farzoom`, `probe-globe-bundle-cost`, `probe-lod-case-paths`, `probe-phong-render`, `probe-replay-cesium-cmd`, `probe-2d-blank-where`, `probe-2dcv-verify`, `probe-billboard-2d-debug`, `probe-collections-entity`, `probe-confirm-inspector-sky`, `probe-fog-ms-toggle`, `probe-fog-state`, `probe-cesiumviewer-screenshot`, `probe-sun-pixel-check`, `probe-pp-effects-audit`, `probe-mrt-validation`, `verify-initial-hdr`, `verify-gp-*` ×2, `probe-gp-*` ×2, `probe-fb-*` ×2, `probe-cloud-cone-parity`, `probe-cesium-man-debug`, `probe-new-sandcastles`, `probe-sandcastle2-ports`, `webgl-vs-webgpu-pixel-check`, `probe-wgs84-*` INVESTIGATION set, `Tools/visual-regression/output/co41-loading-check` etc.) — mark all 'conclusion-banked — archive safe' where WEBGPU_DEBUGGING_LOG cites them; risk per file: low, but each needs a 30-second grep before the ruling (I verified the class, not all ~90 individually).

**LOW confidence** (keep for now):
- `probe-bufferpolygon-2dcv`, `probe-bufferpoint-positiondatatype`, `probe-classifier-textured-materials` — superseded but each has 1 live migration_doc reference; repoint the doc first.
- `probe-farcam-isolation`, `probe-h12-longsettle` — they record *instrument-defect* findings (capture artifacts masquerading as render bugs), a lesson class this repo keeps re-learning; consider promoting their conclusions into DEBUGGING_GUIDE instead of archiving silently.

## 4. COVERAGE GAPS

DEBUGGING_GUIDE's probe inventory (§ line 278) references **49 of 1012 files (~5%)**, skewed heavily to cloud/C13, eclipse, and a handful of standing probes. Entire classes absent:

- **bake-tools (0/~20 referenced)** — nobody debugging a moon/star/tide/STBN asset issue is routed to the reproducible bake.
- **gate-libs (~3/40)** — the verdict/exit-code layer (`verdict-exit-gate`, `provenance-markers`, `probe-fleet-contract`) that explains *why* a probe exits 3.
- **spec fleet (~10/200)** — the durable contracts; fine, specs are run via `node --test`, but the guide never says that.
- **process gates (0)** — C16 suite, landing-rules, pre-push-guard, verify-landing-compliance.
- **runners** — `cross-backend-sandcastle-runner`, `visual-evidence-library` CLI, `variant-smoke-test`, readme-screenshots.
- **utility CLIs** — `diff-two-pngs`, `probe-png-bytes`, `validate-f16-wgsl`, `collection-sentinels-check`.

Proposed view split (matches the guide's own charter of "single entry point for debugging *procedures*"):
- **DEBUGGING_GUIDE keeps**: the decision tree, CesiumDebug catalog, and a *curated* per-subsystem "first probe to run" table (~60–80 entries: the standing ACTIVE probes + capture templates + determinism-kit + error-gate). Add one paragraph each for the utility CLIs and "specs run via `node --test`".
- **New `migration_doc/TOOLING_CATALOG.md`**: the full census — every file with class (probe/spec/gate-lib/lib/fixture/bake-tool/runner/scratch) and status, generated from this audit's classification table so it can be regenerated by script. README.md index points to it as the "everything" view; the guide points to it for anything not in the curated table. This keeps the guide's staleness contract survivable — the catalog absorbs churn, the guide stays small.
- **Process gates** belong in neither — they belong in ORCHESTRATION_HANDBOOK / the C16 queue doc, with a one-line cross-pointer from the catalog.

## 5. ORG PROPOSAL

Measured move cost first: **541** path references inside Tools/scripts/package.json/.husky, **470** in live migration_doc, **~18** in archived docs, plus the fleet-contract allowlist census and `probe-fleet-contract` scanning globs. Any bulk move is a mass edit across ~150 files minimum, on a tree that currently holds live uncommitted work in 30+ of these very files — a strong argument against doing anything big now.

- **Option A — status quo + catalog (recommended now)**: zero breakage; the discovery problem is real but is a *documentation* problem, solved by §4's TOOLING_CATALOG. Cost: none. Weakness: the 865-file flat dir keeps growing.
- **Option B — `archive/` subdir only (recommended as the maintainer-ruled follow-up)**: `git mv` only the ruled archive set (~90–140 files from §3) into `Tools/visual-regression/archive/`, preserving history via `--follow`. Cost is small and verified: the HIGH set has ~0 live doc refs; the MED set's refs are mostly in WEBGPU_DEBUGGING_LOG historical entries (acceptable to leave pointing at old paths *if* the catalog records the move; or a one-time sed across migration_doc). Must-do riders: update `probe-fleet-contract-allowlist` rows, confirm `probe-fleet-contract`'s scan glob doesn't recurse into archive/ (or does, harmlessly), and land outside quiet hours as one batch.
- **Option C — subject subdirs (cloud/, eclipse/, moon/, …)**: rejected. It breaks up to 541 + 470 references, invalidates every runbook, memory file, and archived report path simultaneously, and the name-stem convention already gives you subject clustering for free in a sorted listing. The only durable benefit (namespace hygiene) is delivered more cheaply by B plus the catalog.

Sequencing proposal for the maintainer: (1) land TOOLING_CATALOG (doc-only, no path changes); (2) rule on the §3 HIGH list; (3) execute Option B for the ruled set in one batch with the allowlist edit; (4) revisit MED after D8 lands (the HELD_FOR_D8 files sit in exactly the families the tail touches).

---

## Pending maintainer rulings (M1–M5)

# Maintainer Decisions Memo — Tools/visual-regression `.mjs` Library Audit (2026-08-14)

**Basis:** analyst audit of 865 flat `.mjs` + 74 `lib/` files. Measured: 541 path refs in Tools/scripts/package.json/.husky, 470 in live migration_doc, DEBUGGING_GUIDE covers 49/1012 (~5%), 380/642 probes undocumented, 4 ghost mentions of deleted probes. Excluded from all rulings below per standing rules: `probe-logdepth-zfight` (DELIBERATE_RED_FLAG), the 7 HELD_FOR_D8 files, `sky-band-compare` (UNKNOWN).

---

## M1 — Disposition of archive candidates (~35 HIGH, ~55 MED confidence)

**Options**
- **A. Delete outright.** Pro: smallest tree, no half-state. Con: violates the D7 precedent's spirit even with a ruling — destroys grep-ability of investigation history; the polar-artifact class recurred twice and bring-up probes were wanted again during device-loss work.
- **B. `git mv` to `Tools/visual-regression/archive/`.** Pro: history preserved (`--follow`), flat dir shrinks ~90–140 files, files stay greppable; HIGH set has ~0 live refs so breakage is nil. Con: not a pure `git mv` — every archived probe on the fleet-contract allowlist census needs its row removed in the same change (spec fails on stale rows), and the `probe-fleet-contract` scan glob must be confirmed not to choke on the subdir.
- **C. Tombstone-in-place** (status marked in catalog only, no moves). Pro: zero breakage, zero code edits. Con: the 865-file flat dir stays at full size; "archived" status lives only in a doc, which is exactly the drift pattern that produced the 4 ghost mentions.

**Recommendation: B for the HIGH set (~35 files); C for the MED set until each file gets its 30-second grep** (analyst verified the class, not all ~90 individually), **with the MED ruling revisited after D8 lands** — the HELD_FOR_D8 files sit in the same families. Riders: (1) repoint the 3 single-live-ref files (`probe-bufferpolygon-2dcv`, `probe-bufferpoint-positiondatatype`, `probe-classifier-textured-materials`) before any move; (2) allowlist edits land in the same batch; (3) execute outside quiet hours as one batch; (4) subject to M5's exemplar carve-outs.

## M2 — Catalog documentation and freshness

**Options**
- **A. Extend DEBUGGING_GUIDE only.** Pro: one doc, existing must-stay-synced rule applies. Con: appending ~960 rows to a procedures guide destroys its decision-tree usability, and its staleness contract cannot survive per-batch probe churn.
- **B. New generated `TOOLING_CATALOG.md` only.** Pro: full census, regenerable. Con: the guide's 5% coverage and the "specs run via `node --test`" gap stay unfixed.
- **C. Both, distinct views.** Guide keeps the decision tree + a curated ~60–80-entry "first probe to run per subsystem" table + one paragraph each for utility CLIs and the spec-runner convention; catalog is the generated everything-view (file, class, status); README index points at both. Pro: the catalog absorbs churn so the guide's sync rule stays honorable; each doc has one job. Con: two docs to cross-link.

**Freshness mechanism options:** hand-maintained (rejected — that is how 380 probes went dark); generated from a per-file header. Latter requires a **new fleet-contract rule: every `probe-*.mjs` and `lib/*-gate.mjs` must carry a `@purpose` line** (one sentence + status tag), enforced where the contract already enforces structure, with the generator reading headers so the catalog is `node`-regenerable and drift is a contract failure, not a doc failure.

**Recommendation: C + the `@purpose` fleet-contract rule + a Node generator script.** Rider: fix the 4 ghost mentions in the same doc batch. Process gates (C16 suite, landing-rules, pre-push-guard) get one-line cross-pointers from the catalog to ORCHESTRATION_HANDBOOK, not entries in the guide.

## M3 — Flat directory vs reorganization

**Options**
- **A. Status quo + catalog.** Pro: zero breakage; discovery is a documentation problem M2 solves. Con: flat dir keeps growing.
- **B. `archive/` subdir only** (the M1-B move). Pro: shrinks the working set ~11–16% at verified-small cost; the MED set's stale refs are mostly in WEBGPU_DEBUGGING_LOG historical entries, acceptable if the catalog records the move. Con: the riders in M1.
- **C. Subject subdirectories** (cloud/, eclipse/, moon/…). Pro: namespace hygiene. Con: breaks up to 541 tool-side + 470 live-doc references across ~150+ files, invalidates every runbook, memory file, and archived report path simultaneously — on a tree currently carrying live uncommitted work in 30+ of the affected files. Name-stem convention already yields subject clustering in any sorted listing.

**Recommendation: A now, B as the M1-ruled follow-up, C rejected.** Sequencing: (1) land TOOLING_CATALOG (doc-only), (2) rule M1-HIGH, (3) execute the archive move in one batch with the allowlist edits, (4) revisit MED post-D8.

## M4 — Policy for future probes (anti-re-accretion)

**Options**
- **A. Doc-only convention** (naming + retirement guidance in the guide). Pro: cheap. Con: unenforced conventions are how 642 probes accreted with 4 ghosts.
- **B. Contract-enforced lifecycle.** (i) Naming: keep the `probe-<subject>-<facet>` stem convention, contract-checked. (ii) Self-registration: the M2 `@purpose` header with a status tag (`ACTIVE | INVESTIGATION | ARCHIVED-CANDIDATE`) — a new probe is catalog-visible on next regeneration with zero manual doc work. (iii) Retirement ritual, added to landing-rules: an investigation probe closes by banking its conclusion in WEBGPU_DEBUGGING_LOG, then either promotion to a spec/standing gate or an archive move + allowlist-row removal in the same commit. Pro: enforcement lives in gates that already run; retirement becomes part of landing a fix, not a separate cleanup campaign. Con: small per-probe overhead; one-time contract work.
- **C. B + scheduled re-audit cadence** (e.g. per major campaign close). Pro: catches leakage. Con: recurring cost.

**Recommendation: B, with C's re-audit run once at each campaign close-out as a checklist line rather than a standing lane.**

## M5 — Exemplar retention and instrument-defect lesson promotion (added; the report makes it necessary)

The MED archive set contains two classes worth deliberate exception handling: (a) technique exemplars — the stash-based A/B recipe (cloud V-series) and raw-readback probes (canvas-black era) encode reusable methodology; (b) **instrument-defect records** — `probe-farcam-isolation` and `probe-h12-longsettle` document capture artifacts masquerading as render bugs, a lesson class this repo has re-learned at least three times (Batch 767, 816, 1033 doctrine entries).

**Options**
- **A. No exceptions** — archive per M1. Pro: simple. Con: silently archives the exact material the verification doctrine keeps re-deriving.
- **B. Retain one exemplar per technique class in the live dir (marked in `@purpose`), and promote the two instrument-defect findings into a short DEBUGGING_GUIDE subsection before their files are archived.** Pro: methodology stays discoverable at near-zero file cost; consistent with Principle 7's bias against destroying scaffolding. Con: judgment call on which exemplar; two guide paragraphs to write.

**Recommendation: B.** Concretely: keep one cloud stash-A/B probe and one raw-readback probe live; the rest of both classes follow the M1 MED path.

---

**Requested rulings:** M1 (B-for-HIGH / defer-MED), M2 (C + `@purpose` contract rule), M3 (A-then-B, reject C), M4 (B + close-out re-audit), M5 (B). All destructive steps await your explicit ruling per D7; nothing moves before TOOLING_CATALOG lands and nothing lands inside quiet hours.

---

> **Census regeneration (ruling M2).** Everything between the markers below is
> GENERATED by `node Tools/generate-tooling-catalog-launcher.cjs` from each file's own
> `@purpose` / `@status` header — edit the file, not the table. The analyst
> report and the maintainer rulings above are human prose and are never
> touched by the generator.
> The tracked CommonJS launcher is the independently reviewable provenance
> boundary: it is intentionally outside this `.mjs` census, seals Node startup
> state, and releases candidate output only after a challenge-bound completion
> receipt verifies the materialized candidate subject and verdict.
>
> Until `Tools/inject-purpose-headers.mjs` has been applied to the tree, the
> census below is still the audit's hand-built table and
> `node Tools/generate-tooling-catalog-launcher.cjs --check` must be green for a current catalog.
> The landing batch that applies the codemod regenerates this section in the
> same commit, and the check goes green from there on.

<!-- BEGIN GENERATED CENSUS — regenerate with `node Tools/generate-tooling-catalog-launcher.cjs`; edits inside this region are overwritten -->

## Full census

Columns: file (basename), class, status, last git touch, inbound refs, purpose. Generated from each file's own `@purpose` / `@status` header (ruling M2) — edit the FILE, not this table. `NO @purpose HEADER` names a file that has not self-registered yet, so the gap is visible rather than absent. Class comes from a file's `@class` tag when it carries one and from its path otherwise. Inbound refs count the distinct files under `Tools/`, `scripts/`, `migration_doc/`, `.husky/`, `package.json` and `lint-staged.config.js` that name the file (this catalog itself excluded).

| Metric | Value |
|---|---|
| Files in census | 1044 |
| ACTIVE | 843 |
| INVESTIGATION | 195 |
| NO @purpose HEADER | 6 |
| Classes | probe 644, spec 190, other 96, lib 74, gate-lib 18, bake-tool 12, runner 6, fixture 4 |

### Tools/ (31)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| audit-feature-renderers.mjs | other | ACTIVE | 2026-08-16 | 2 | Node audit that FeatureRendererKey enum, registerFeatureRenderer sites and getFeatureRenderer consumers stay mutually consistent; CI/pre-commit gate. |
| backup-worker-deliverables.mjs | other | ACTIVE | 2026-08-20 | 1 | Export each worker clone's authored work as a self-contained, verified-appliable patch bundle so nothing depends on a clone surviving, while quiet hours forbid committing. |
| build-eot20-constituent-grid.mjs | other | ACTIVE | 2026-08-16 | 3 | Offline bake of the EOT20 ocean-tide constituent atlas into the TCG1 grid read by Core/TideConstituentGrid.js (CC BY 4.0, attribution mandated). |
| build-geoid-undulation-grid.mjs | other | ACTIVE | 2026-08-16 | 4 | Bakes the bundled coarse EGM2008 geoid grid (egm2008-0p5deg.i16) consumed by Core/GeoidUndulationGrid.js for the ocean GEOID vertical datum. |
| build-lake-water-mask.mjs | other | ACTIVE | 2026-08-16 | 4 | Converts Natural Earth 1:10m lakes polygons into the packed LWM1 binary bundled for LakeWaterClassificationProvider (globe.lakeWaterMask). |
| codex-mcp-launcher.mjs | other | ACTIVE | 2026-08-20 | 6 | Resolve the Codex CLI across its hash-versioned install directories and exec `codex mcp-server` for .mcp.json; stable across desktop-app updates. |
| codex-preflight.mjs | other | ACTIVE | 2026-08-20 | 2 | Prove a Codex worker can actually run before a batch is dispatched: resolves the CLI, checks auth, and fires a minimal canary exec to detect quota exhaustion and report the reset time. |
| collection-sentinels-check.mjs | other | ACTIVE | 2026-08-16 | 2 | Fast no-GPU smoke check of the three permanent fault sentinels in WebGPUCollectionRendererBase via in-memory esbuild transpile; <1s local run. |
| dev-server-artifact.spec.mjs | spec | ACTIVE | 2026-08-20 | 0 | Verify that the development server selects and validates the requested Cesium artifact without opening a socket. |
| generate-tooling-catalog.mjs | other | ACTIVE | 2026-08-21 | 5 | Regenerates the TOOLING_CATALOG census section from @purpose/@status headers, git freshness and inbound refs; --check fails on drift. |
| generate-tooling-catalog.spec.mjs | spec | ACTIVE | 2026-08-21 | 2 | Self-test for the catalog generator: marker containment, determinism, drift reporting and the no-header row. |
| inject-purpose-headers.mjs | other | ACTIVE | 2026-08-16 | 3 | Idempotent codemod injecting @purpose/@status headers into the tooling .mjs fleet from the library-audit rows. |
| inject-purpose-headers.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Self-test for the @purpose header codemod: mapping, placement, byte-exactness, idempotence and the dry-run report. |
| karma-default-browsers.spec.mjs | spec | NO @purpose HEADER | 2026-08-21 | 0 | — |
| landing-rules.mjs | other | ACTIVE | 2026-08-16 | 11 | Pure landing-discipline predicates (quiet-hours window, Batch-N subject grammar, body, co-author trailer) shared by pre-push hook and detector. |
| landing-rules.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Hermetic contract for the landing predicates: control+mutant per rule, DST-straddling quiet-hours pairs, narrow merge exemptions. |
| lint-debug-pragmas.mjs | other | ACTIVE | 2026-08-16 | 3 | Lints Renderer/WebGPU for console.log/warn/debug/info calls not wrapped in //>>includeStart('debug') pragmas; console.error exempt by policy. |
| pre-push-guard.mjs | other | ACTIVE | 2026-08-16 | 9 | Git-aware driver behind .husky/pre-push: enforces batch-prefix/body/trailer/quiet-hours on every outgoing agent commit; fail-closed, no bypass flag. |
| pre-push-guard.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | End-to-end wiring contract: hook fires on push, not on fetch/pull, and is POSIX-sh clean, exercised in a throwaway temp repository. |
| provision-worker-clone.mjs | other | ACTIVE | 2026-08-21 | 1 | Provision a worker clone with the governance git cannot deliver, create the local main ref the handoff diff needs, and REFUSE if any routed authority is unreachable. |
| run-far200-shadow-self-test.mjs | runner | ACTIVE | 2026-08-16 | 2 | Thin bootstrap: esbuild-bundles Tools/far200-shadow-self-test.ts and executes it via a data: URL import. |
| upstream-regression-check.mjs | other | ACTIVE | 2026-08-16 | 7 | Standalone Node re-verification of eight ported upstream fixes (imagery-layers guard, parseUrl, octDecode arg order, etc.); exit 0 = all hold. |
| variant-smoke-test.mjs | other | ACTIVE | 2026-08-16 | 22 | Playwright smoke test of each build variant's IIFE bundle (dual/webgl-only/webgpu-only): Viewer constructs, frames render, zero console errors. |
| verify-landing-compliance.mjs | other | ACTIVE | 2026-08-16 | 8 | After-the-fact detector that re-runs the landing rules + C16 marker gate over a landed commit range, making any --no-verify hook bypass visible. |
| verify-landing-compliance.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Contract for the bypass detector against immutable history: known-bad C12-37 landing must red, known-good B1041-1043 landing must pass. |
| verify-tracked-references.mjs | other | ACTIVE | 2026-08-21 | 6 | Asserts every node launch target in package.json/.mcp.json and every relative import in changed .mjs/.cjs/.js files resolves to a path the tree actually tracks. |
| verify-tracked-references.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Contract for the tracked-reference guard: mutation controls where a tracked referrer points at an untracked target must red, and the all-tracked control must stay green. |
| verify-worker-handoff.mjs | other | ACTIVE | 2026-08-20 | 2 | Mechanically validate a worker clone before review: lease compliance, no git writes, no conflict artifacts, header and comment-marker rules, and execution of every spec the worker added. |
| wasm-encode-benchmark.mjs | other | ACTIVE | 2026-08-16 | 6 | Node CPU micro-benchmark of the WASM batch_rte_encode kernel vs the scalar JS fround twin, with byte-identity and fallback trip-wire asserts. |
| wasm-subrange-encode-check.mjs | other | ACTIVE | 2026-08-16 | 6 | Standalone Node check that WasmRTEBridge.batchEncodeRange's WASM and JS paths are byte-identical, placement exact, outside bytes preserved. |
| wasm-subrange-loader.mjs | other | ACTIVE | 2026-08-16 | 3 | ESM resolve hook redirecting WasmRTEBridge's build-layout wasm-glue specifier to the on-disk glue so the wasm Node checks run the real bridge. |

### Tools/archive/ (7)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| apply-logdepth-flatbasic.mjs | other | INVESTIGATION | 2026-08-16 | 1 | One-shot codemod adding LOG_DEPTH //>>ifdef blocks + FragOut struct swap to the 21 Mat*Flat/Basic WGSL primitive shaders. |
| apply-logdepth-matlit.mjs | other | INVESTIGATION | 2026-08-16 | 1 | One-shot codemod adding LOG_DEPTH //>>ifdef blocks to the 19 Mat*Lit WGSL primitive shaders, mirroring the PrimitivePhongColor recipe. |
| apply-logdepth-pbr.mjs | other | INVESTIGATION | 2026-08-16 | 1 | One-shot codemod adding LOG_DEPTH blocks to PrimitivePBRSimple/Textured WGSL (clipPosition VS treatment + FragOut return swap). |
| batch-117-wrap-returns.mjs | other | INVESTIGATION | 2026-08-16 | 1 | One-shot codemod rewrapping every fragmentMain return in GlobeTerrain.wgsl to makeFragOutput(...) for the G-buffer MRT conversion. |
| batch-121-wrap-lit-shaders.mjs | other | INVESTIGATION | 2026-08-16 | 2 | One-shot codemod converting 19 Mat*Lit + 2 Phong primitive shaders to emit FragOutput so they populate G-buffer slot 1 (normalRoughness). |
| wire-flat-shaders-aerial-lut.mjs | other | INVESTIGATION | 2026-08-16 | 1 | One-time codemod that wired the aerial-perspective LUT (EffectsUniforms + fog blend) into every Flat primitive WGSL shader from a template. |
| wire-globe-mrt-normal.mjs | other | INVESTIGATION | 2026-08-16 | 2 | One-time codemod rewriting GlobeTerrain.wgsl's fragmentMain to the 2-attachment MRT output (color + normal-roughness G-buffer). |

### Tools/c16/ (10)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| comment-marker-guard.mjs | other | ACTIVE | 2026-08-21 | 12 | C16 lint guard scanning engine/widgets Source for banned tracker-marker vocabulary, with a clean-list ratchet; lint-staged + one-shot modes. |
| comment-marker-guard.spec.mjs | spec | ACTIVE | 2026-08-21 | 1 | node:test contract for the C16 marker guard: rules still match (self-test vs broken rule), scope does not overreach, ratchet honest both ways. |
| comment-only-diff.mjs | other | ACTIVE | 2026-08-16 | 5 | Binding gate of every C16 rewrite batch: strips comments from both sides of a diff to a canonical form and requires the remaining code identical. |
| comment-only-diff.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Mutant suite for the comment-only-diff gate: every rejected mutant is paired with the nearest legitimate edit that must be accepted. |
| spec-anchor-sweep.mjs | other | ACTIVE | 2026-08-20 | 2 | Reports grammar, comment-only, and containment-locator anchors from spec literals against explicitly supplied source files. |
| spec-anchor-sweep.spec.mjs | spec | NO @purpose HEADER | 2026-08-20 | 0 | — |
| string-literal-marker-scan.mjs | other | ACTIVE | 2026-08-21 | 3 | Finds banned tracker vocabulary inside string and template literals that the comment-marker guard intentionally cannot see. |
| string-literal-marker-scan.spec.mjs | spec | ACTIVE | 2026-08-21 | 1 | Proves the string-literal marker scanner sees planted markers, excludes non-literal text, and depends on the shared marker grammar. |
| verify-packaged-notices.mjs | other | ACTIVE | 2026-08-16 | 4 | Verifies every third-party license notice actually reaches each published artifact (root/engine/widgets LICENSE.md, ThirdParty.json, release zip). |
| verify-packaged-notices.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Mutant suite for the packaged-notices check: removes one owed notice/wiring element at a time and requires the removal reported. |

### Tools/c16/lib/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| comment-scanner.mjs | lib | ACTIVE | 2026-08-16 | 8 | The one tokenizer both C16 instruments share (JS/TS/WGSL/GLSL comment vs code vs string), fail-closed, with semantic-comment retention rules. |
| marker-grammar.mjs | lib | ACTIVE | 2026-08-21 | 6 | Machine-decidable half of the fork comment standard: the banned tracker-vocabulary regex rules (add-only ids) driven by the marker guard. |

### Tools/lib/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| purpose-header.mjs | lib | ACTIVE | 2026-08-16 | 8 | The one shared @purpose/@status header grammar (parse, locate, byte-exact splice, violations) used by the codemod, the catalog generator and the fleet-contract analyzer. |
| webgpu-error-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 152 | Shared Playwright gate catching unscoped WebGPU validation/OOM errors (onuncapturederror) and device loss, plus a console-error listener. |

### Tools/moon-albedo-bake/ (4)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| bake-lola-normals.mjs | bake-tool | ACTIVE | 2026-08-16 | 5 | Reproducible lunar normal-map bake from NASA LOLA ldem_16 displacement: pinned SHA-256, area downsample, derive, encode, verify, manifest, install. |
| bake-lroc-color.mjs | bake-tool | ACTIVE | 2026-08-16 | 6 | Reproducible lunar albedo bake from NASA SVS 4720 lroc_color_poles_2k: pinned SHA-256, sRGB passthrough, JPEG q90 encode, landmark verify, manifest. |
| lunar-landmarks.mjs | bake-tool | ACTIVE | 2026-08-16 | 5 | Dependency-free landmark alignment checker pinning the lunar albedo map's orientation (180-shift / lon-mirror / lat-mirror each trip a named check). |
| lunar-relief.mjs | bake-tool | ACTIVE | 2026-08-16 | 3 | Dependency-free derivation + verification of the lunar tangent-space normal map (east-north-up frame), shared by bake and asset spec. |

### Tools/readme-screenshots/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| capture-readme-screenshots.mjs | runner | ACTIVE | 2026-08-16 | 2 | One-command Playwright capture of every image the README feature table references (sandcastle/viewer/page scenes from scenes.json manifest). |
| capture-readme-screenshots.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Browser-free enforcement of the README-table <-> scenes.json contract plus the capture script's probe-fleet safety membership; mutant-tested. |

### Tools/readme-screenshots/lib/ (5)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| capture-plan.mjs | lib | ACTIVE | 2026-08-16 | 2 | Pure schedule half of a capture run: which scenes run, per-scene budget, manifest-derived watchdog, and what counts as already-captured on disk. |
| console-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 2 | Host-keyed predicate deciding whether a browser console error belongs to this fork (fatal) or to a third-party tile service (ignorable). |
| dead-routes.mjs | lib | ACTIVE | 2026-08-16 | 2 | Derives the legacy script URLs demo pages still request but nothing serves, and fulfils them with empty 200s so only real 404s stay fatal. |
| image-anchors.mjs | lib | ACTIVE | 2026-08-16 | 4 | PNG content anchors (brightSpot, horizonCoverage) proving the capture subject is in frame, since DOM chrome alone can pass pixel-percentage floors. |
| readme-table.mjs | lib | ACTIVE | 2026-08-16 | 2 | Shared parser + bidirectional cross-check between the README feature table and the screenshot manifest, imported by both runner and spec. |

### Tools/skybox-bake/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| bake-tycho-t5.mjs | bake-tool | ACTIVE | 2026-08-16 | 8 | Reproducible Tycho star-map bake: SMPTE gamma-1.8 to sRGB transfer, equirect to six GL cube faces, blurred diffuse + unblurred variants, manifest. |
| starmap-census.mjs | bake-tool | ACTIVE | 2026-08-16 | 13 | Orthogonal point-source census + degree-scale band-structure metrics that make the DR-01 diffuse/sprite ownership split falsifiable both ways. |

### Tools/star-catalog-bake/ (1)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| bake-star-catalog.mjs | bake-tool | ACTIVE | 2026-08-16 | 3 | Regenerates the BrightStarCatalog.js data table from the pinned HEASARC BSC5P archive, deepening the embedded sky to naked-eye magnitude. |

### Tools/stbn-bake/ (5)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| bake-stbn.mjs | bake-tool | ACTIVE | 2026-08-16 | 4 | Reproducible spatiotemporal blue-noise bake: deterministic generate, quantise, spectral certify (abort on fail), encode raw .bin + tile-atlas PNG. |
| stbn-core.mjs | bake-tool | ACTIVE | 2026-08-16 | 4 | STBN generation from published algorithms (Ulichney void-and-cluster, Georgiev-Fajardo energy, Wolfe separable spatiotemporal criterion). |
| stbn-png.mjs | bake-tool | ACTIVE | 2026-08-16 | 3 | Minimal spec-derived 8-bit greyscale PNG encoder/decoder so the STBN bake and its node:test spec need no native image dependency. |
| stbn-rng.mjs | bake-tool | ACTIVE | 2026-08-16 | 3 | Deterministic license-clean random stream for the STBN bake: AES-256-CTR over zeros keyed by SHA-256(seed), byte-identical across machines. |
| stbn-spectrum.mjs | bake-tool | ACTIVE | 2026-08-16 | 5 | Fourier certification of an STBN volume (radial spatial spectrum, per-pixel temporal spectrum, cross-correlation) with mutants proving each bar fires. |

### Tools/visual-regression/ (862)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| analyze-cross-backend-report.mjs | other | ACTIVE | 2026-08-16 | 4 | Post-processes the cross-backend sandcastle sweep's report.json into pass/fail/diff buckets and issue categories for a PR-ready summary. |
| assess-c11-146-route.mjs | other | ACTIVE | 2026-08-16 | 3 | C11-146 route wrapper: fingerprints local+served inputs around the clean moving-altitude run, assesses the artifact, preserves first red. |
| attachment-demand-registry.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Pure-Node spec of computeAttachmentDemand (esbuild-transpiled TS): full 2^6 reader matrix + conservative-force + observe-only contracts. |
| backend-isolation-lane-contract.spec.mjs | spec | ACTIVE | 2026-08-20 | 0 | Pin the backend-isolation split lane to the page's explicit launch and readiness contract. |
| bug-11-imagery-probe.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Early diagnostic dumping the per-tile imagery probe (debugShowImageryProbe) + canvas sample to discriminate three hypothesized BUG-11 root causes. |
| c11-13-public-voxel-pick-convergence.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | node:test contract for the public voxel-pick convergence state machine (two identical consecutive cells = stable; undefined never converges). |
| c11-13-voxel-inside-camera-harness.mjs | other | ACTIVE | 2026-08-16 | 3 | Browser-side ESM harness driving a voxel octree scene through inside/outside-volume camera waypoints on either backend for the C11-13 probe. |
| c11-13-voxel-inside-camera-probe.spec.mjs | spec | ACTIVE | 2026-08-21 | 2 | Browser-free policy + mutant suite for the physical Edge inside-camera voxel probe: waypoint sequence, pixel/command evidence, watchdog ordering. |
| c11-13-voxel-pick-pipeline-name.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins the exact voxel-pick log-depth pipeline identity across Picking.js, VoxelPrimitive.js, the WebGPU pick pass and the probe that observes it. |
| c11-14-webgl-anisotropy-tangent-fallback.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Executes the WebGL anisotropy tangent-frame branches extracted from the live shader and requires the tangent-less fallback to match both WebGPU anisotropy paths. |
| c11-146-route-evidence.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Contract + mutants for the C11-146 route-evidence policy: provenance fingerprinting, artifact assessment, first-red preservation, CLI wiring. |
| c11-168-direct-model-ablation-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Browser-free policy + mutant suite for the C11-168 direct-model ablation causal discriminator: leg config, invocation shape, child-process handling. |
| c11-188-translucent-twin-node-matrix.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Execute the real material packer through both live call sites so the twin differs only by pass class. |
| c11-19-globe-pipeline-name-axes.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Execute the real globe descriptor builder and keep its diagnostic name complete without changing non-name behavior. |
| c11-205-owner-attribution-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Contract + mutants for C11-205 owner-attribution evidence: collector, lock records, first-red decisions, pair comparability, runner wiring. |
| c11-205-resident-readiness.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Pure-Node contracts for the resident 3D-Tiles residency precondition and the PASS/FAIL/STRUCTURAL exit classification shared by probe and campaign. |
| c11-209-effects-placeholder-provenance.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins the C11-209 effects-placeholder probe's provenance wiring: source/build/served-byte fingerprints, structural gate, analyzer-visible close. |
| c11-22-debug-depth-plane-gate-parity.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Execute both backend gate statements and the debug command so skip/restore remains parity-safe. |
| c11-24-render-command-pass-slot.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Instantiate the real extracted command path and route immediate draws to the active WebGPU pass encoder. |
| c11-90-primitive-restart-harness.mjs | other | ACTIVE | 2026-08-21 | 3 | Browser-side harness loading primitive-restart strip/fan GLB models per backend, recording pipeline recreation history for the C11-90 probe. |
| c11-90-primitive-restart-harness.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Contract for the C11-90 harness + probe pair: topology expectations, backend/shape authority, watchdog ordering, probe-fleet contract membership. |
| c12-11-star-catalog-gate.spec.mjs | spec | NO @purpose HEADER | 2026-08-21 | 3 | — |
| c12-29-s4-orbital-sunrise-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Gate spec for C12-29 S4 orbital-sunrise certification: band/anchor constants, independent extinction oracle, artifact shape, probe route wiring. |
| c12-29-s5-custom-ellipsoid-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Gate spec for the C12-29 S5 custom-ellipsoid certification: geometry oracles, eclipse bindings, cross-backend derivation, v6 gate fold, mutants. |
| c12-29-s5-dense-cost-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Gate spec for the C12-29 S5 dense-cost certification: schedule/workload validation, long-task selection, legacy + superseded schema folds, sentinels. |
| c12-29-s5-multiview-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Gate spec for the C12-29 S5 multiview certification: phases, renderer set, WebGPU VR error contract, evidence lifecycle and lock/watchdog wiring. |
| c12-29-s5-replacement-device-gate.spec.mjs | spec | ACTIVE | 2026-08-21 | 2 | Certifies the S5 eclipse-shadow replacement-device evidence pipeline: schemas, phases, ledger/provenance validators, gate fold of its probe+lib pair. |
| c12-29-s5-svs-footprint-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | node:test half of the NASA/SVS umbra-footprint certification triple (probe + gate-lib + spec) for the S5 eclipse globe shadow. |
| c12-29-s5-terrain-selection-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Certifies the S5 terrain-selection evidence gate: v4-v9 schema migrations, page-diagnostic validation, canonical capture checks, exit-code fold. |
| c12-31-aureole-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | node:test half of the C12-31 L1-L4 sky-aureole certification triple (probe-sky-aureole-anchor + gate lib + spec). |
| canvas-black-narrow.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Narrows the black-canvas bug by rendering three paths (default PP chain, depth overlay, frustum tint) and reporting which yields non-black pixels. |
| canvas-black-readback.mjs | other | INVESTIGATION | 2026-08-16 | 2 | Reads back the sceneFramebuffer color texture via copyTextureToBuffer/mapAsync to prove whether the globe pass wrote any color, ignoring the PP chain. |
| canvas-black-trace.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Renders 60 WebGPU frames capturing all [WebGPU:] console output to pin whether globe commands submit and pass validation (black-canvas bug). |
| canvas-format-probe.mjs | other | INVESTIGATION | 2026-08-16 | 0 | One-shot dump of presentation/preferred/scene color formats and the HDR-canvas flag from a live WebGPU viewer. |
| capture-and-diff.mjs | runner | ACTIVE | 2026-08-16 | 36 | Primary VR runner: drives the split-screen page over scenes.json, captures WebGL+WebGPU canvases, evaluates 3 gates vs reviewed historical baselines. |
| capture-and-diff.policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | node:test guard for lib/visual-gate-policy.mjs: pixel-gate evaluation, scene thresholds/expectations, manifest and baseline-promotion validation. |
| celestial-capture-harness.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Mutation-checked guard for lib/celestial-capture-harness.mjs, including its shared frozen-PNG acquisition path. |
| celestial-g1-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Browser-free mutant-battery guard of the G1 celestial gate predicates (star modulation, sky floor, sprite deltas, cubemap certifying mode). |
| celestial-g2-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Guards the G2 star-PSF gate: display-transform inversion round-trip, PSF discrimination vs the old truncated Gaussian, composition rules, via mutants. |
| celestial-g3-gate.spec.mjs | spec | ACTIVE | 2026-08-21 | 5 | Guards the G3 Milky-Way cubemap gate: arcmin/px definition pinning, orthogonal structure metrics, T3 adversarial rejection, real-byte format arm. |
| celestial-g4-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Guards the G4 sun/moon gate: thresholds re-derived from shipped Scene modules, synthetic-frame recovery proofs, eight aimed mutants each rejected. |
| celestial-gate-class-audit.spec.mjs | spec | NO @purpose HEADER | 2026-08-20 | 2 | — |
| celestial-metrics.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Trust anchor for lib/celestial-metrics.mjs: each metric (census, contrast tail, chroma, falloff, magnitude fidelity) run on closed-form images. |
| celestial-uniform-offsets.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Derives WGSL uniform-layout offsets for the star cubemap + sprite buffers from struct source and pins the JS packers' flat indices against them. |
| cloud-coverage-response.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Pins the CLOUD-LOW-COVERAGE-CUTOFF fix: baked base-field support, monotone coverage response on the CPU twin, exact high-anchor preservation. |
| cloud-density-domain.spec.mjs | spec | ACTIVE | 2026-08-21 | 5 | Pins the cloud density-domain layout: noise origin/phase/rotation float offsets shared between WebGPUCloudDensityDomain.ts and the WGSL, via exports. |
| cloud-density-lod.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins LOD agreement across CloudDensityDomain.wgsl, ProceduralClouds.wgsl and ProceduralSkyCubemap.wgsl via direct source reads. |
| cloud-genus-morphology.spec.mjs | spec | ACTIVE | 2026-08-21 | 5 | C13-16 cirrus row: add-only uniform layout, exact CUMULUS byte-neutrality, structural fibre anisotropy/shear metrics, mutation-rejected predicates. |
| cloud-ibl-revision.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Source-anchored guard that WebGPUDynamicEnvironmentMapManager and the procedural cloud renderer keep the IBL revision handshake wired (CRLF-safe). |
| cloud-image-analysis.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | node:test guard for lib/cloud-image-analysis.mjs: analyze/compare/periodicity-factorial classification on deterministic synthetic noise images. |
| cloud-march-emission.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | C13-10: march-emitted reconstruction depth behind one compile-time bit, four sibling pipelines compile verbatim, CPU-twin cross-validation, mutants. |
| cloud-march-transfer.spec.mjs | spec | ACTIVE | 2026-08-21 | 3 | Permanent home of the R3 march-transfer model: predicts the integrated image against 2026-08-06 tour ground truth; mutation group rebuilt non-vacuous. |
| cloud-morphology-composition.spec.mjs | spec | ACTIVE | 2026-08-21 | 1 | C13-16 U2 candidate contract: genus-conditioned variance budget + fibre carve before erosion; WGSL wiring invariants and carve-after-erosion mutants. |
| cloud-noise-mipmaps.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins WebGPUCloudNoiseResources + CloudNoiseMipmap.wgsl mip-chain agreement, with a loud guard on the halve-to-1 loop's integer precondition. |
| cloud-observability-counters.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | C13-02 Gate-A: cloud GPU total is a union not a sum, Sky Fill excluded, per-frame counters reset, pass counts tied to encode sites. |
| cloud-primary-shell.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Validates CloudVolumetrics WGS84 shell ray-root math at orbital heights with f32-conditioning-aware tolerances (nadir / near-horizon / grazing). |
| cloud-probe-harness.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Guards lib/cloud-probe-harness.mjs + cloud-perf-evidence pass resolution: config round-trip through the collection contract across six cloud probes. |
| cloud-ray-jitter.spec.mjs | spec | ACTIVE | 2026-08-21 | 3 | Pins the cloud ray-jitter contract across ProceduralClouds.wgsl, CloudDensityDomain.wgsl, the renderer and tier presets via source reads. |
| cloud-reconstruction-attachments.spec.mjs | spec | ACTIVE | 2026-08-21 | 5 | C13-09: attachment table add-only, march shader content-hash pin enforcing the C13-39 static-register constraint, stage default-OFF byte/cost neutral. |
| cloud-reconstruction-consume-probe.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Pins the C13-10 Edge consume-probe's own instrument properties: real interleave schedule, null-not-zero pass timing, the 3-vs-2 producer-target move. |
| cloud-refresh-skip.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Pins the repair of the requestRenderMode frozen-frame defect that made both cloud-reconstruction probes count render calls as frames; mutant-checked. |
| cloud-shadow-rte.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | C13-06 cloud shadow/mask/env-capture/atmosphere RTE contract: f64 frame-owner math, f32 WGS84-vs-spherical oracle, source ownership, naga validation. |
| cloud-temporal-rte.spec.mjs | spec | ACTIVE | 2026-08-21 | 4 | Pins WebGPUCloudTemporalHistory reset classification (teleport, morph, deck bounds, scene mode...) and commit semantics vs the engine module. |
| cloud-tour-sequences.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | C13-01 tour contract: fixture/sequence coverage per the queue row, pinned derived clocks, engine-export constants, probe capture discipline. |
| cloud-u2-perf-evidence.spec.mjs | spec | ACTIVE | 2026-08-21 | 1 | Guards lib/cloud-u2-perf-evidence.mjs manifest assessment for C13-16 U2 perf evidence (no-regression / unchanged pass expectations, lane shapes). |
| collection-pass-routing.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Guards which Pass bin WebGPU collection renderers put COLOR commands in and that PICK commands are emitted — pins the B914 enum-branch inversion fix. |
| collection-pickid-shape.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Guards that WebGPU collection renderers register WebGL-shaped pick-id wrappers ({primitive, collection, id}), not bare primitives; CO-16 census guard. |
| coveragejson-antimeridian.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | C13-08: CoverageJSON cyclic-longitude unwrap through WeatherFieldGrid + WeatherTexPacker so antimeridian-crossing CRS84 axes parse right. |
| cpu-frame-accounting.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Deterministic-clock tests of WebGPUCpuPassProfiler whole-scene phase accounting (CPU_SCENE_PHASE_NAMES coverage, no wall-clock leakage). |
| cpu-primitive-breakdown-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Policy guard for probe-c11-169-primitive-breakdown: first-red policy, detail controls, instrumentation evaluation and capture normalization vs source. |
| cpu-scene-phase-integration.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Pins the CPU scene-phase list agreement across Scene.js, ViewportExecutor.js and WebGPUSceneRenderer.ts (vm-executed source integration check). |
| cross-backend-sandcastle-runner.mjs | other | ACTIVE | 2026-08-16 | 7 | Runs every Sandcastle demo under WebGL then WebGPU via a Viewer shim injecting contextOptions.renderer, pixel-diffs the pair, writes per-demo reports. |
| daynight-terminator-law.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | CLT-B1 Node half: transcribed laws vs shaders, calibration inversion, ramp classifier, structural exit codes — all mutant-rejected. |
| debug-ground-polyline-color.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Instruments the GroundPolyline renderer cache to find why per-instance color didn't reach the FS (dim-rectangle diagnosis, 2026-04-30). |
| diag-b3dm-cmds.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Dumps commandList contents during a b3dm tileset render to explain a uniform dark-gray WebGPU canvas. |
| diag-b3dm-depth.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Checks terrain-flush b3dm renders with globe SHOWN after the logDepthWriteActive multi-frustum fix; dumps frustum partition + globe-ON screenshot. |
| diag-b3dm-webgpu.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Deep WebGPU-only diagnostic for a black canvas despite a loaded b3dm tileset, ready model and populated primitive cache. |
| diag-exag-water-streaks-2x2.mjs | other | INVESTIGATION | 2026-08-16 | 4 | 2x2 {backend}x{atmosphere} capture + rendered tile levels + lake-streak metric; branch-decider for the exaggerated-terrain bright-lake streak bug. |
| diag-exag-water-streaks-source.mjs | other | INVESTIGATION | 2026-08-16 | 3 | Runtime-toggles fog/ground-atmosphere/sky-atmosphere to isolate the source of the exaggerated-Himalaya blue streaks; no rebuild required. |
| diag-globe-belowsurface-decomp.mjs | other | ACTIVE | 2026-08-16 | 4 | Per-term A/B decomposition of the WebGPU below-surface darkening residual via pragma-stripped bypass-* globe-fragment modes, one load/scenario. |
| diag-groundprim-extents.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Dumps GroundPrimitive planar texcoord batch attributes + eye-space east extent to locate the ~4x WebGPU surfaceUV frequency mismatch. |
| diag-ktx2-ibl-shape.mjs | other | INVESTIGATION | 2026-08-16 | 4 | Dumps loadKTX2 cube buffer shape + IBL load-chain intermediate state to pin why the KTX2 specular cube never went ready. |
| diag-stars-hdr-autoexposure.mjs | other | INVESTIGATION | 2026-08-16 | 6 | Runtime AE-on vs AE-off capture testing whether always-on WebGPU auto-exposure crushes bright HDR catalog stars on a near-black starfield. |
| diag-taa-black.mjs | other | INVESTIGATION | 2026-08-16 | 5 | One-off diagnostic capturing all console message types + per-frame TAA stats while the canvas went black with TAA enabled. |
| diff-two-pngs.mjs | other | ACTIVE | 2026-08-16 | 1 | General CLI pixel-exact PNG diff with optional bottom-crop and exit 0 iff zero drift; the byte-identity gate tool of the diff family. |
| disable-skyatmo-probe-wgl.mjs | other | INVESTIGATION | 2026-08-16 | 0 | WebGL twin of disable-skyatmo-probe: disables skyAtmosphere/groundAtmosphere/fog/skyBox and captures, for dark-sky layer attribution. |
| disable-skyatmo-probe.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Disables skyAtmosphere/groundAtmosphere/fog/skyBox on WebGPU and captures, isolating which environment layer caused the dark-sky bug. |
| earth-pixel-probe.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Loads CesiumViewer once per backend at one pinned camera and samples RGB at fixed screen points (center/ocean/continent/sky) to quantify color shift. |
| eclipse-cloud-ibl-response.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | C13-41 (C12-29 S3 rider): pins seven exact-1.0 non-eclipse identity sites, rejects the S2 scene-factor shadow substitution, both env-bake halves. |
| eclipse-cloud-response-gate.spec.mjs | spec | ACTIVE | 2026-08-21 | 7 | Pure-Node half of C13-41's Edge acceptance: recomputes the pre-registered bands, derives the sweep refresh count, mutant-checks every fold predicate. |
| eclipse-globe-shadow-visual.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Pins probe-eclipse-globe-shadow.mjs structure: canonical same-task capture embed and eclipse/control x on/off isolation on both backends. |
| eclipse-globe-svs-oracle.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | External S5 oracle: EclipseGlobeShadow model outputs vs published NASA 2024-04-08 figures (path centres, 197.5 km umbra width, falloff, shadow speed). |
| eclipse-globe-umbra-rte.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | C12-29 S5 regression contract: CPU fit/composition laws, camera-independent common-ray representation, matching WebGL/WebGPU resource architecture. |
| eclipse-high-precision-dependency.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins the astronomy-engine 2.1.19 dependency: fixture provenance byte/hash fingerprints vs the resolved installed package (supply-chain gate). |
| eclipse-ladder-rungs.mjs | other | ACTIVE | 2026-08-16 | 6 | Obscuration ladder + rung-separation validation for the S2 dimming probe; extracted from page.evaluate to fix the 0.9+0.1 knife-edge reject. |
| eclipse-sandcastle.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Static contract for the Sandcastle2 Eclipse Explorer demo: inline frozen preset authority, gallery file set, metadata, vm-checked main.js. |
| eclipse-scene-dimming.spec.mjs | spec | ACTIVE | 2026-08-16 | 8 | C12-29 S2: scene-light/atmosphere dimming curve, ~5-lux totality floor, eclipseAutoExposure default (ruling E2), exact-1.0 identities, 4 JS sites. |
| eclipse-sky-totality.spec.mjs | spec | ACTIVE | 2026-08-21 | 10 | C12-29 S6 sky half: obs-1 dynamic-lighting resolution root cause, ruling E3 star-brightness modulation (derived curve, exact off), horizon twilight. |
| eclipse-state.spec.mjs | spec | ACTIVE | 2026-08-16 | 9 | Pins C12-29 S1 eclipse math: limb-darkened dual-cone obscuration, frameState.eclipseState contract, off-toggle identity, both-backend alpha fade. |
| env-background-clear.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Proves the empty-frame background loss was WebGPUContext.clear dropping the ClearCommand; pins the WebGPUCanvasClearState fix and its wiring. |
| env-frustum-demand.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Unit spec for EnvironmentFrustumDemand: when the camera-range window must be restored so a frustum exists to carry the environment layer. |
| env-matrix-shape.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Browser-free trust anchors for probe-env-pass-matrix: shape-based sun/moon body detector and night source contract, pinned on synthetic ground truth. |
| environment-refresh-drain.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins the C11-193 environment-refresh scheduler's no-starvation latency bound and the persistent target pool against a duck-typed fake GPU device. |
| environment-refresh-priority.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Pins C11-193C same-frame dynamic-environment demand ordering in WebGPUEnvironmentRefreshCoordinator, GPU-free via esbuild-transpiled TS. |
| fog-cheap-coverage-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | Pins the fog cheap-path cloud-shadow coverage gate: samples standardised onto the baked field's moments, with mutants and byte-neutrality. |
| globe-daynight-normal-source.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Pins that every WGSL globe day/night term reads the analytic geocentric normal, not the mesh v_normalEC whose constant decode flattened lighting. |
| globe-daynight-ramp-law.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Pins that GlobeTerrain.wgsl's day/night ramp and diffuse express GlobeFS.glsl's two laws, coefficients captured from both sources, with mutant tests. |
| globe-night-lights-default.spec.mjs | spec | ACTIVE | 2026-08-20 | 1 | Verifies that durable Globe source defaults night lights to an opt-in feature. |
| globe-night-ocean-sentinel.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins the GLOBE_UB_UNSET (-1.0) sentinel that made enableNightLights=false reachable: OFF and default-ON no longer share the same 0.0 uniform encoding. |
| globe-pipeline-key-contract.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Pins the single-home globe pipeline cache-key builder/parser after the 15-month UNO_/UNMO_ producer-consumer drift; accessors + cache stats. |
| globe-pipeline-readiness.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Scoring tests plus engine mechanism pins for probe-globe-pipeline-readiness; a pin failure means the traced path changed, not the instrument. |
| globe-use-log-depth.spec.mjs | spec | ACTIVE | 2026-08-16 | 8 | Pins that the globe resolves the shared isWebGPULogDepthActive gate so orthographic modes never mix log and hyperbolic encodings in one depth buffer. |
| gpu-timestamp-unique-sample-accounting.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Pins the GPU timestamp profiler's union-fold frame coverage (overlap surfaced, never double-counted) and its no-silent-loss attempt ledger. |
| ground-fog-band.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | Pins the inscribed-sphere altitude bug that made ground fog arithmetically absent, the Koschmieder-derived fix, four mutants, and byte-neutrality. |
| ground-polyline-smoke.mjs | other | ACTIVE | 2026-08-16 | 2 | Early smoke probe loading the WebGPU viewer and checking GroundPolylinePrimitive classifier presence plus console health. |
| gsplat-campaign15-instruments.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Extract and execute the real gsplat classification predicates and View frustum binning, mutant-test both, and pin the C15-G7/G6 pure instrument models. |
| gsplat-frame-variance.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Certifies the C15-G9 D1-D5 frame-variance model, probe contract, source predicate, and loud mutants. |
| gsplat-harness.spec.mjs | spec | ACTIVE | 2026-08-16 | 8 | Mutation-tests the C15-G1 dual-mode gsplat gate so the absence/presence flip and blank-canvas parity can never go green vacuously. |
| hdr-display-default.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Acceptance for HDR-defaults-on on HDR displays: pins the pure decision function because headless Edge cannot synthesize (dynamic-range: high). |
| j2-cpu-kernel.mjs | other | ACTIVE | 2026-08-16 | 4 | FP64 secular-J2 orbital propagator mirroring the demo's WGSL kernel; single source of truth for two orbital probes and the WebGL2 cpuKernel leg. |
| logdepth-zfight-probe-contract.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Browser-free contract pinning probe-logdepth-zfight's deterministic offline scene and retained terrain-depth policy. |
| mat-logdepth-encode-stash.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Executes the real writeLogDepthTail packer to pin stash-first log-depth encoding for the Mat/Primitive family; replays the 2-primitive defect. |
| model-3d-tile-state-packet.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral tests for Model3DTileStatePacket: immutable packet reuse when broad tileset state is unchanged, refresh on real change. |
| model-camera-arena.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Bundles the real WebGPUModelCameraArena and pins offset alignment, per-frame reset, view isolation, plus call-site routing source checks. |
| model-device-recovery.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Device/resource-generation recovery contracts for native Models across renderer, pipeline cache, device resources and stub texture sources. |
| model-lazy-pick-demand.spec.mjs | spec | ACTIVE | 2026-08-20 | 2 | Contracts for lazy realization of native Model pick resources across renderer, feature-id, Model, feature table and batch texture sources. |
| model-light-arena.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Light-slice sibling of the camera-arena spec: pack-once-per-model-per-view light block, removal from per-primitive group-1, WGSL binding move. |
| model-native-pipeline-stage-tax.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Asserts which model pipeline stages are skipped when the native WebGPU renderer owns a primitive, pinning the stage-tax reduction. |
| model-primitive-topology-sandcastle.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins that the KHR primitive-restart Sandcastle demo survives the live WebGPU Viewer transform and remains valid module syntax. |
| model-primitive-topology.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Contract for glTF mode to WebGPU topology+stripIndexFormat mapping: atomic pair, LINE_LOOP/FAN expansion on real assets, restart legality. |
| moon-albedo-asset.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | Pins the bundled lunar albedo asset bytes, equirect orientation landmarks, both-backend flipY upload convention and LICENSE provenance. |
| moon-atmosphere-appearance.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Pins moon in-scatter sky-wash, Lommel-Seeliger reflectance and opposition surge on BOTH backends plus the CPU integrator's numeric contracts. |
| moon-decoded-source-cache.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral tests for MoonDecodedSourceCache: canonical URL keying, dedupe, deferred decode settlement and decoded-source close accounting. |
| moon-globe-depth-routing.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Node harness contracts around the moon/globe depth-occlusion probe: run lock, provenance, continuity images, watchdog, evidence finalization. |
| moon-mip-lod-shader.spec.mjs | spec | ACTIVE | 2026-08-21 | 4 | Structural WGSL contract for Moon derivative/LOD sampling, asserted per @fragment entry point: exactly one ellipsoid hit shaded, explicit gradients, no duplicated color evaluation. |
| moon-mip-motion-certification.spec.mjs | spec | ACTIVE | 2026-08-21 | 4 | Certification-pipeline contracts for the narrower C12-33 shimmer envelope: honest non-claim, minimum sensitivity, immutable evidence, review, and finalization. |
| moon-mip-motion-probe-contract.spec.mjs | spec | ACTIVE | 2026-08-21 | 1 | Contract over the C12-33 shimmer-envelope probe: honest scope, frame analysis, exit codes, evidence paths, and minimum paired sensitivity. |
| moon-normal-map-asset.spec.mjs | spec | ACTIVE | 2026-08-16 | 7 | Pins the bundled lunar normal map bytes/format, crater-relief polarity, 1/cos(lat) derivation math, both-backend wiring and LICENSE provenance. |
| moon-normal-strength-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral contract for backend-neutral resolveMoonNormalMapStrength defaults and clamping, run against a real Moon instance under Node. |
| moon-phase-gate.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Regression tripwire: the Moon.wgsl whole-disc phaseGate multiplier stays deleted; C12-21 scaffolding and naga validation preserved. |
| moon-phase-terminator.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Cross-language equivalence of softTerminatorMu0 (WGSL/GLSL/JS to 1e-15) plus property predicates proven against four wrong implementations. |
| moon-webgl-explicit-gradients.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Structural GLSL contract: Moon UV derivatives execute before miss discards under LUNAR_EXPLICIT_GRADIENTS on the WebGL path. |
| moon-webgl-mip-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral tests of the WebGL moon mip policy: NPOT mip generation under WebGL2, trilinear/linear sampler selection, mip level counts. |
| moon-webgl-texture-lifecycle.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral tests of the WebGL moon texture lifecycle: channel commit/reconcile, publish/retire ordering and upload-source release accounting. |
| moon-webgpu-mip-lifecycle.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Pins the WebGPU Moon's frame-owned mip-chain realization across context, stub init, environment renderer and lifecycle sources. |
| moon-webgpu-texture-lifecycle.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral tests of the WebGPU moon texture lifecycle: pair keys, candidate commit, channel reconcile, retire and diagnostics accounting. |
| nasa-svs-5073-umbra-fixture.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Offline pin of the exact cropped NASA SVS 5073 umbra_lo shapefile shard (byte hashes, optional full-source reconstruction); no rendering. |
| ocean-datum.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Analytic trust anchor for the datum probe: table sanity, regression/classifier correctness, exit-code mapping, probe-model drift check. |
| ocean-tide-datum.spec.mjs | spec | ACTIVE | 2026-08-16 | 7 | Pins the bundled EGM2008 grid, equilibrium TideModel phase/amplitude physics, geoid-then-tide composition order and the exact-zero off-contract. |
| ocean-wave-lod.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Extracts ocean-wave march constants from WGSL/GLSL/TS and pins integer-repeat lockstep, fade-band parity, amplitude fade, f32 precision bounds. |
| performance-workloads.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | Large browser-free contract suite over the performance-campaign lib surface: schedules, pacing, evidence, ledgers, URL and manifest validation. |
| pick-frustum-math.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Unit tests for the extracted PickFrustumMath drawing-buffer-to-frustum coordinate mapping and pick-frustum half extents. |
| pipeline-key-aliasing.spec.mjs | spec | ACTIVE | 2026-08-16 | 17 | Guard for the pipeline-cache shader-identity fold: executes real caches over every ShaderDefine bit; mutation group re-inflicts the aliasing. |
| probe-2d-blank-where.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | BUG-3 localizer: screenshots SCENE2D on both backends and maps WHERE non-black pixels are (off-screen vs mis-scaled vs depth-failed vs sky-only). |
| probe-2d-cv-modes.mjs | probe | ACTIVE | 2026-08-16 | 10 | Verifies SCENE2D and Columbus View render the globe on WebGPU after the camera-UB tileRectangle/projected-meters fix, per mode and backend. |
| probe-2d-frustum-bins.mjs | probe | ACTIVE | 2026-08-16 | 6 | SCENE2D multi-frustum binning dump (per-frustum near/far, command counts per pass, billboard plane distances) for pass-overwrite-class bugs. |
| probe-2d-globe-render.mjs | probe | ACTIVE | 2026-08-16 | 4 | Regression guard for the Batch 167 2D regional-zoom cull fix: WebGPU vs WebGL lit-pixel ratio at regional and full-globe 2D over Lake Superior. |
| probe-2d-zoom-globe.mjs | probe | ACTIVE | 2026-08-16 | 4 | Entry-point diagnostic for a blank 2D globe: compares tile selection, load queues, 2D frustum and globe command counts across backends and zooms. |
| probe-2dcv-verify.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | BUG-3 visual verification: instant-morphs to 2D and CV on both backends, screenshots plus pixel stats behind the WebGPU error gate. |
| probe-adapter-limits-quick.mjs | probe | ACTIVE | 2026-08-16 | 1 | Fast dump of four key GPUAdapter limits (vertex buffers/attributes, bind groups, max buffer size) from the viewer page in one default Edge config. |
| probe-adapter-limits.mjs | probe | ACTIVE | 2026-08-16 | 2 | Dumps WebGPU adapter limits across multiple Chromium launch configs (DXGI vs explicit Vulkan vs high-performance) to find the best-limit path. |
| probe-aerial-froxel.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance for the froxel 3D-LUT aerial-perspective fast path: renders, far-band haze signature, distinct from OFF, analytic parity path intact. |
| probe-aerial-lut-primitive.mjs | probe | ACTIVE | 2026-08-16 | 4 | Verifies primitives' effects bind group actually forwards the aerial-perspective LUT: polyline must fog with atmosphere ON vs OFF, not stay same. |
| probe-aerial-perspective.mjs | probe | ACTIVE | 2026-08-16 | 9 | Acceptance for the unified aerial-perspective post-process: renders, contributes, depth-correct far-band haze, no double-darkening, no GPU errors. |
| probe-aerial-runtime-config.mjs | probe | ACTIVE | 2026-08-16 | 3 | Proves aerialPerspectiveConfig intensity/inscatterScale are runtime-mutable per frame on the WebGPU aerial-perspective effect, with OFF-gate. |
| probe-align-test.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Searches best (dx,dy) offset between pre-captured northpole WebGL/WebGPU PNGs to detect a positional shift between backends. |
| probe-all-materials.mjs | probe | ACTIVE | 2026-08-16 | 9 | Audits every Material.fromType lit material renders on WebGPU without device errors; reports JS-packed UB layout/size vs WGSL structs. |
| probe-async-resource-monitor.mjs | probe | ACTIVE | 2026-08-16 | 3 | Smoke test that AsyncResourceMonitor/Telemetry accumulate pipeline tokens and p50/p95 latency while the globe renders under requestRenderMode. |
| probe-atmo-lighting.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance for atmosphere-derived model lighting: derived sun colour + sky irradiance shift model hue warm at low sun, consistent with terrain. |
| probe-atmo-lut-no-device-error.mjs | probe | ACTIVE | 2026-08-16 | 7 | Gate that the extended-LUT passes run with explicit pipeline layouts and zero device errors while the sun steps, with no error filter. |
| probe-atmo-lut-off.mjs | probe | ACTIVE | 2026-08-16 | 5 | Verifies the WGSL ground-atmosphere inline analytic fallback matches WebGL when the LUT is forced unavailable, 3 views, pinned clock. |
| probe-atmo-luts.mjs | probe | ACTIVE | 2026-08-16 | 6 | Reads back multiple-scattering + irradiance LUT texels and asserts physical relationships (MS brightens sky, irradiance falls with zenith). |
| probe-atmo-moon-438.mjs | probe | ACTIVE | 2026-08-16 | 4 | Finds a real moonlit night via ICRF scan, then asserts dualLightInline ON gives clear moon-glow luminance vs OFF on the inline sky march. |
| probe-atmo-physics-438.mjs | probe | ACTIVE | 2026-08-16 | 1 | Mode-driven acceptance for ozone dusk deepening, improved Mie aureole, and inline moon glow, plus an off-mode pre/post byte-parity baseline. |
| probe-atmo-resolver-consistency.mjs | probe | ACTIVE | 2026-08-16 | 4 | Gate that the shared WebGPUAtmosphereUniforms resolver feeds dynamic-atmosphere lighting into BOTH sky and model-IBL consumers. |
| probe-atmosphere-orbit.mjs | probe | ACTIVE | 2026-08-16 | 7 | Ablation: full/sky-only/ground-only/all-off atmosphere at orbit, pixel-diffing WebGL vs WebGPU per config to attribute the orbit residual. |
| probe-atmosphere-toggle.mjs | probe | ACTIVE | 2026-08-16 | 7 | Captures both backends with showGroundAtmosphere ON and OFF (4 PNGs) to confirm the per-fragment drape path and a clean OFF state. |
| probe-atmosphere-unification.mjs | probe | ACTIVE | 2026-08-16 | 3 | Static source-scan invariant guard: all 4 sky-integral consumers sample the ONE shared LUT bake; exit 1 if any diverges to a private table. |
| probe-atmospheric-effects-b.mjs | probe | ACTIVE | 2026-08-16 | 1 | Logic probe for the conditions-to-effects hierarchy + effects.auto master: pure mapper cases, effects tree, auto on/off byte-neutrality. |
| probe-atmospheric-effects.mjs | probe | ACTIVE | 2026-08-16 | 1 | Logic probe for the Phase-A conditions-to-knobs mapper and applyAtmosphericConditions writing scene knobs (warm-moist vs cold-dry). |
| probe-attach-mismatch.mjs | probe | ACTIVE | 2026-08-16 | 3 | Scans demos for 'Attachment state of [RenderPipeline]' warnings — detects format/sample-count drift between cached pipelines and passes. |
| probe-attachment-demand-registry.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance that the per-frame attachmentDemand record matches actual scene-FB behavior for default frame + each G-buffer consumer, observe-only. |
| probe-b3dm-noglobe.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Minimal check that the BatchTableHierarchy b3dm tileset renders on WebGPU with the globe removed from the picture. |
| probe-b3dm-render-edge.mjs | probe | ACTIVE | 2026-08-16 | 5 | Re-verifies the stale NEW-BG-CONSOLIDATION claim: b3dm renders non-black on Edge WebGPU and matches WebGL, ellipsoid terrain to rule out occlusion. |
| probe-backend-isolation.mjs | probe | INVESTIGATION | 2026-08-20 | 3 | Answered 2026-07-19 maintainer questions: is a WebGL context still created in webgpu mode, and does split-screen cost what solo costs. |
| probe-batch65-state.mjs | probe | ACTIVE | 2026-08-16 | 3 | State dump proving mercator-vs-geographic texture bind decisions stay in lock-step with cached translation/scale at 4 views. |
| probe-bathymetry-state.mjs | probe | ACTIVE | 2026-08-16 | 2 | Boots the Sandcastle Bathymetry demo on forced-WebGPU via the renderer-override shim and dumps console/page state. |
| probe-bb-cv-diag.mjs | probe | ACTIVE | 2026-08-16 | 3 | Reproducer measuring magenta billboard coverage in steady 3D/2D/CV, globe off — bisects the billboard quad-size parity defect vs morph gaps. |
| probe-billboard-2d-debug.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Raw introspection of one billboard in SCENE2D: actual position, command BV, frustum-bin survival, manual clip position from packed matrices. |
| probe-billboard-atlas-vflip.mjs | probe | ACTIVE | 2026-08-16 | 3 | Parity acceptance for billboard atlas UV orientation (asymmetric image + SDF glyph) across scene modes, plus pick coverage of the quad. |
| probe-billboard-partial-write.mjs | probe | ACTIVE | 2026-08-16 | 7 | Acceptance for resident-instance partial writes: 0 uploads settled, ~1-stride write on one move, moved billboard renders at its new position. |
| probe-billboard-pick.mjs | probe | ACTIVE | 2026-08-16 | 8 | Billboard pick gate: pickAsync hit/miss/repeatability plus pipeline-cache hygiene (pick entry present, no duplicate cache names). |
| probe-bisect.mjs | probe | ACTIVE | 2026-08-16 | 2 | Generic bisection harness: toggles sky/ground atmosphere, fog, skybox per label and captures a PNG of the WebGPU frame for each combo. |
| probe-blend-math-bisect.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Offline diff of pre-captured OLD straight-mix vs NEW premultiplied WGSL captures vs WebGL: per-row mismatch and where the math fix helps. |
| probe-bloom-no-globe.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Bloom.html forensics variant: globe.show=false to identify what fills the lower half during the missing-terrain bloom investigation. |
| probe-bloom-no-msaa.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Bloom.html forensics variant: msaaSamples=1 to test whether the missing-terrain issue was MSAA-related. |
| probe-bloom-no-pp.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Bloom.html forensics variant: bloom stage disabled — models must still render, isolating the post-process stage from scene content. |
| probe-bloom-no-sky.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Bloom.html forensics variant: skyAtmosphere disabled to isolate the sky's contribution to the bloom-frame anomaly. |
| probe-bloom-parity.mjs | probe | ACTIVE | 2026-08-16 | 6 | Bloom uniform-parity gate: default-uniform bloomed-fraction band vs WebGL, glowOnly + brightness response, stripped scene with synthetic sun. |
| probe-bloom-side-by-side.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Samples the same pixels in WebGL and WebGPU Bloom.html renders to confirm what content each backend actually placed there. |
| probe-bloom-tile-state.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Forensics on Bloom.html globe-pass commands — dumps tile draw state to attribute the bloom-frame terrain anomaly. |
| probe-boot-prewarm-c10-06.mjs | probe | ACTIVE | 2026-08-16 | 4 | Deterministic oracle that the globe shader prewarm runs at context init and beats the first tile draw (console-log ordering, no wall-clock). |
| probe-brightness-bisect.mjs | probe | ACTIVE | 2026-08-16 | 2 | Bisects the globe brightness gap via the post-composite-color debug mode: bright there = bug downstream of composite, dim = in composite. |
| probe-brightness-no-atmo.mjs | probe | ACTIVE | 2026-08-16 | 3 | Brightness-ratio variant with ground atmosphere off on both backends — separates drape-branch darkening from the imagery-composite chain. |
| probe-brightness-ratio.mjs | probe | ACTIVE | 2026-08-16 | 6 | Standing per-globe-pixel WebGL/WebGPU mean-RGB brightness ratio at 5 camera distances; RED outside [0.5,2.0]; JSON report for trends. |
| probe-buffer-2dcv-parity.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance for Buffer* (Point/Polyline/Polygon) 2D/Columbus-View reprojection parity — pixel-diffs both backends in all three scene modes. |
| probe-buffer-integer-position.mjs | probe | ACTIVE | 2026-08-16 | 4 | Render-diff acceptance for integer + positionNormalized decode on WebGPU Buffer*: normalized-SHORT cross coincides with DOUBLE control. |
| probe-buffer-logdepth-zfight.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance that the Buffer* family writes log depth: coverage tracked against a co-located log-depth billboard reference at far nadir. |
| probe-buffer-point-single.mjs | probe | ACTIVE | 2026-08-16 | 4 | Regression gate for the WebGL single-vertex BufferPoint path (count==1 sub-data update): lone point renders, moves, zero errors. |
| probe-buffer-point-update.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance for the upstream #13465 fix: setPosition after first render re-encodes and moves the point on BOTH backends within 2 frames. |
| probe-buffercoll-encode-benchmark.mjs | probe | ACTIVE | 2026-08-16 | 8 | Repack+upload benchmark of BufferPointCollection position encode (batch vs forced-scalar) at 10k/50k/100k, both backends, visual check. |
| probe-buffercoll-wasm-encode.mjs | probe | ACTIVE | 2026-08-16 | 5 | Parity acceptance that the WASM/batch fround RTE encode renders pixel-identical to scalar EncodedCartesian3, plus threshold routing checks. |
| probe-bufferpoint-positiondatatype.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Gap-documentation gate: detectUnsupportedPositionEncoding flags integer/normalized BufferPoint layouts and warns once instead of mis-encoding. |
| probe-bufferpolygon-2dcv.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Pre-fix baseline recorder: captures the expected-LARGE 2D/CV diff for BufferPolygon (wandering points) as the before-image for the fix. |
| probe-bufferpolygon-outline.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance for BufferPolygon outlineColor/outlineWidth: red stroke on both rings, width-0 renders nothing, OFF-gate byte-identical. |
| probe-bufferpolygon-vector-tile.mjs | probe | ACTIVE | 2026-08-16 | 9 | Verifies the us-states vector tileset renders through the BufferPolygon WGSL path on both backends: 52 features, matching geometry bytes. |
| probe-bulk-vs-legacy-perf.mjs | probe | ACTIVE | 2026-08-16 | 3 | Benchmark settling bulk static-lane vs legacy per-frame visualizer: setup and steady per-frame cost per entity count, point path isolated. |
| probe-bundle-content.mjs | probe | ACTIVE | 2026-08-16 | 3 | Hooks GPURenderBundleEncoder + pipeline creation to dump what draw state the globe tile render bundle records (targets, blend, depth). |
| probe-c-r9-diagnose.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | C-R9 bisect: baseline vs debugSkipDepthPlane vs windowed Turbo depth overlay to test whether the depth plane occluded the b3dm buildings. |
| probe-c-r9-webgl-vs-webgpu.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | C-R9 control: same-view WebGL-vs-WebGPU b3dm render with explicit ellipsoid terrain, ruling out legitimate terrain occlusion first. |
| probe-c10-02-pixel.mjs | probe | ACTIVE | 2026-08-16 | 6 | Pixel + drillPick oracle for styled b3dm: cropped building-region capture and stats per unstyled/subset/all mode, drillPick feature check. |
| probe-c10-02-style-economics.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Diagnostic that decided style-command economics: translucentFeaturesLength upkeep, styleCommandsNeeded polarity, per-scenario command counts. |
| probe-c10-07-async-model-pipelines.mjs | probe | ACTIVE | 2026-08-16 | 5 | Wraps createRenderPipeline(Async) pre-device to prove Model PBR pipelines compile async (sync=0, no stall) and the model still renders. |
| probe-c10-09-prev-buffer-upload.mjs | probe | ACTIVE | 2026-08-16 | 7 | Acceptance that TAA prev-instance buffers seed once via GPU copy then skip while unchanged, with one-upload mutation exactness (cloud leg). |
| probe-c10-10-shadow-single-sweep.mjs | probe | ACTIVE | 2026-08-16 | 7 | Verifies the shadow caster-list fold: sublist reference-identical to the old full scan incl. off-camera casters, shadows still render. |
| probe-c10-11-blend-pickability.mjs | probe | ACTIVE | 2026-08-16 | 4 | Design-ruling proof: translucent Model BLEND picks stay depth-test-only and pickable, A/B'd across the pick-fleet log-depth switch. |
| probe-c10-11-ddtd-hitrate.mjs | probe | INVESTIGATION | 2026-08-16 | 6 | Hit-rate A/B of the globe-pick point sequence with the pick-fleet switch FALSE/TRUE, showing the occasional miss is a pre-existing race. |
| probe-c10-11-mixed-coherence.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance that the native pick fleet writes coherent log depth: mixed families occlude/reveal monotonically at 20/500/5000 km. |
| probe-c10-12-over-occlusion.mjs | probe | ACTIVE | 2026-08-16 | 4 | Load-bearing guard for the pick-depth-plane flip: plane-on visible-face pick hit-rate must be >= plane-off at every altitude. |
| probe-c11-13-voxel-inside-camera.mjs | probe | ACTIVE | 2026-08-16 | 3 | Thin entry point running the shared C11-13 voxel camera-inside-volume probe from lib/, with an outer watchdog ordered to lose to the inner. |
| probe-c11-168-direct-model-ablation.mjs | probe | ACTIVE | 2026-08-16 | 3 | Fresh-process causal discriminator: two reverse-order quartets, each leg a separate Node runner + fresh Edge measuring the 600-frame route. |
| probe-c11-169-primitive-breakdown.mjs | probe | ACTIVE | 2026-08-16 | 4 | Tools-only CPU discriminator nesting four instance-local timers inside the profiler's coarse phases, engine default path untouched. |
| probe-c11-193b-shared-submit.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance that dynamic-IBL refreshes ride the shared scene encoder/submit: no private submits, exact 44-pass contribution per manager. |
| probe-c11-193c-demand-priority.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance for dynamic-IBL demand priority: HIGH-before-NORMAL admission, bounded lossless deferral, budget semantics, late 2D promotion. |
| probe-c11-196-lazy-pick-demand.mjs | probe | ACTIVE | 2026-08-20 | 3 | Discriminator that model pick resources stay cold during color rendering, realize synchronously on first pick demand, then remain stable. |
| probe-c11-202-batchtexture-pick-demand.mjs | probe | ACTIVE | 2026-08-20 | 3 | Gate that ordinary model picking does not realize the legacy BatchTexture pick registry/texture first; verifies picked feature properties. |
| probe-c11-205-lifecycle-v2.mjs | probe | ACTIVE | 2026-08-16 | 6 | Attribution probe: schema-v2 multiple-content observer on the real MultipleContents 1.1 fixture + versioned model-state packet mutation gates. |
| probe-c11-209-effects-placeholder-startup.mjs | probe | ACTIVE | 2026-08-16 | 3 | Startup acceptance that the effects depth-placeholder init encoder creates exactly the expected textures/views/passes, via native WebGPU API wrappers |
| probe-c11-210-compute-command-list.mjs | probe | ACTIVE | 2026-08-20 | 1 | Acceptance that a real WebGPU compute command appended to Scene's commandList executes inside the product frame encoder across normal/pick/2D lanes |
| probe-c11-90-primitive-restart-split.mjs | probe | ACTIVE | 2026-08-16 | 3 | Thin retained entry point running the C11-90 primitive-restart WebGL2-vs-WebGPU harness from lib/c11-90-primitive-restart-probe.mjs |
| probe-c12-29-s4-orbital-sunrise.mjs | probe | ACTIVE | 2026-08-16 | 2 | Certifying 400 km orbital-sunrise acceptance: 181 pinned one-second samples in normal + blend-neutral lanes, fail-closed write-once evidence lifecycle |
| probe-c12-29-s5-custom-ellipsoid.mjs | probe | ACTIVE | 2026-08-16 | 6 | Runtime certification that a custom oblate ellipsoid renders and derives identically on serial fresh WebGL and WebGPU contexts; write-once evidence |
| probe-c12-29-s5-dense-cost.mjs | probe | ACTIVE | 2026-08-16 | 4 | Dense ACTIVE/INACTIVE eclipse-lane cost characterization: 24 child Node processes, each one fresh Edge running one 600-frame condition in frozen order |
| probe-c12-29-s5-multiview.mjs | probe | ACTIVE | 2026-08-16 | 3 | Logical-View/stereo policy certification: offscreen ray View, WebGL two-eye VR executor, WebGPU synchronous unsupported-path rejection |
| probe-c12-29-s5-replacement-device.mjs | probe | ACTIVE | 2026-08-21 | 6 | Genuine device-loss recovery certification via Chromium GPU-process termination (never destroy()); 'destroyed' losses archived STRUCTURAL not recovery |
| probe-c12-29-s5-svs-footprint.mjs | probe | ACTIVE | 2026-08-16 | 3 | Absolute NASA-SVS 5073 eclipse geospatial-footprint acceptance over the vendored four-row fixture + local QuantizedMesh, serial WebGL/WebGPU |
| probe-c12-29-s5-terrain-selection.mjs | probe | ACTIVE | 2026-08-16 | 3 | Real-terrain/selection acceptance: fill-to-real transitions, x2 radius law, async picking, env-map capture over local QuantizedMesh, both backends |
| probe-c9-14-ground-atmo-stage.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Before/after self-diff captures (ground/horizon/orbit) proving the globe ground-atmosphere Nishita march runs in exactly one shader stage |
| probe-camera-construct.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Patches the Camera constructor to log aspectRatio/drawingBuffer/fov/position at construction per renderer — startup camera-state diagnostic |
| probe-camera-issue.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | One-off diagnostic for WebGPU Sandcastle demos ignoring camera setView/flyTo, using a forced-renderer Viewer shim per demo |
| probe-camera-track.mjs | probe | ACTIVE | 2026-08-16 | 11 | Connected orbit-to-ground camera track capturing + diffing both backends at each waypoint to surface tile-streaming/LOD artifacts along motion |
| probe-canvas-format.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Dumps WebGPU canvas/presentation format, HDR flags and post-process stage state from a live viewer |
| probe-canvas-timing.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Samples canvas pixel/CSS dimensions every 100 ms during Sandcastle boot to trace resize timing per renderer |
| probe-canvas-vs-screenshot.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Instrument self-check: compares getImageData bytes vs page.screenshot of the same canvas state to detect Playwright capture transforms |
| probe-celestial-extinction-cache.mjs | probe | ACTIVE | 2026-08-16 | 4 | C9-06 close-out acceptance: cached sun/moon extinction bit-equals uncached physics, dusk warm-keep kills star pop-in, backends agree to exact IEEE-754 |
| probe-celestial-extinction-revision-gate.mjs | probe | ACTIVE | 2026-08-16 | 3 | Proves shared sun/star extinction is cached by exact physical inputs and the daytime star gate exits before feature-renderer/cache/draw work |
| probe-celestial-gates.mjs | probe | ACTIVE | 2026-08-21 | 22 | Campaign 12 celestial gate harness: measured G1-G4 star-field gates on both backends with cubemap/sprite source-split and in-column modulation lanes |
| probe-cesium-man-debug.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Batch 141 deep-dive capturing CesiumMan device-error context and timing (startup-only vs per-frame clustering) |
| probe-cesium-man-race.mjs | probe | ACTIVE | 2026-08-16 | 2 | Wraps encoder methods before model load to stack-trace the CesiumMan locked-encoder race at the first offending call |
| probe-cesium-viewer.mjs | probe | ACTIVE | 2026-08-16 | 4 | Boot smoke: standalone CesiumViewer on WebGPU, samples canvas pixels + post-process pipeline state, bypassing the split-screen page |
| probe-cesiumviewer-screenshot.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Minimal WebGPU CesiumViewer boot dumping frame-state stats and one screenshot |
| probe-channel-materials.mjs | probe | ACTIVE | 2026-08-16 | 3 | Regression: all six channel/channels-uniform materials construct and render with zero device errors (MaterialHelpers inheritance + offset-order fixes) |
| probe-classification-primitive-parity.mjs | probe | ACTIVE | 2026-08-16 | 4 | Standalone ClassificationPrimitive parity: terrain-classifying box, coverage within 25% of WebGL, pick returns instance id, zero device errors |
| probe-classifier-2d-renderpass.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Diagnostic pinpointing which dispatch left a render pass open for GroundPrimitive classification in SCENE2D/CV |
| probe-classifier-extents-inspect.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | No-rebuild check whether packExtents finds planar-extent batch-table attributes (root-cause of the flat textured-classifier symptom) |
| probe-classifier-logdepth-flip.mjs | probe | ACTIVE | 2026-08-16 | 8 | Log-depth Slice 3a payoff: WebGL ref vs WebGPU flag-OFF/ON startup flip — classifier stripes become visible when eye-z reconstruction is precise |
| probe-classifier-logdepth-settle.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Settle-until-tilesLoaded variant of the classifier log-depth comparison for reproducible coverage (no tile-streaming variance) |
| probe-classifier-scenemode.mjs | probe | ACTIVE | 2026-08-16 | 5 | Regression guard: flat-color GroundPrimitive classification renders in SCENE3D/SCENE2D/COLUMBUS_VIEW with enforced coverage and zero device errors |
| probe-classifier-textured-materials.mjs | probe | INVESTIGATION | 2026-08-16 | 13 | Textured GroundPrimitive materials (Stripe/Checkerboard/Grid/Image) variance parity WebGPU vs WebGL |
| probe-clipping-planes-parity.mjs | probe | ACTIVE | 2026-08-16 | 5 | glTF Model clipping-planes parity: clipped region matches across backends and picks return nothing on the clipped side, the model on the visible side |
| probe-cloud-aerial.mjs | probe | ACTIVE | 2026-08-16 | 4 | W4 aerial-perspective gate: blend coefficient must grade with distance (far >> near) via the runtime strength toggle; single-run PASS bars |
| probe-cloud-ambient.mjs | probe | ACTIVE | 2026-08-16 | 3 | W2 sky-ambient/ground-bounce gate: shadow-side p10 luminance lifted into band and cloud tops bluer than bottoms; single-run PASS bars |
| probe-cloud-banding.mjs | probe | ACTIVE | 2026-08-16 | 6 | C13-36 ray-start-jitter quality oracle: OFF-subtracted coherent-band metric on provenance-locked before/after pairs; fails closed on stale companions |
| probe-cloud-clockbind.mjs | probe | ACTIVE | 2026-08-16 | 3 | Proves cloud advection is scene-clock-bound: identical frames at a frozen clock across wall time, different frames for clock times 3 h apart |
| probe-cloud-cone-parity.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | B436 zero-drift landing gate: one deterministic cinematic-tier capture, byte-compared across pre/post-436 builds via git stash |
| probe-cloud-config.mjs | probe | ACTIVE | 2026-08-16 | 2 | Weather-config foundation gate: cloud appearance dials are live without rebuild and unset defaults reproduce the pre-config frame |
| probe-cloud-density-domain.mjs | probe | ACTIVE | 2026-08-16 | 5 | C13-37 baked-density periodicity oracle: same-build legacy/new density-domain x baked/live x midpoint/IGN factorial, failing closed on encoder timing |
| probe-cloud-depth-occlusion.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | B409 A/B (stash pair) showing the cloud raymarch clamps at scene depth so far-side clouds no longer bleed through the globe disc |
| probe-cloud-diagonal.mjs | probe | ACTIVE | 2026-08-16 | 3 | Regression for the fullscreen-triangle fix: an overcast deck must fill the top-right quadrant (old triangle rasterized only half the screen) |
| probe-cloud-dials.mjs | probe | ACTIVE | 2026-08-16 | 2 | B407 struct-growth dials gate: puffSize/exposure/msDecay wired end-to-end, defaults byte-identical, reset returns to the default render |
| probe-cloud-empty-frustum.mjs | probe | ACTIVE | 2026-08-16 | 6 | C13 acceptance: zero-frustum frames still schedule cloud/post/env work when demanded, while the true-empty fast path still skips it all |
| probe-cloud-exotic-flags.mjs | probe | ACTIVE | 2026-08-16 | 2 | U7 gate: exotic E1/E2 dials (mammatus/species/feature) reach the raymarcher via collection.volumetric; off states byte-identical |
| probe-cloud-extinction.mjs | probe | ACTIVE | 2026-08-16 | 1 | B408 V11 per-genus optical extinction gate: cumulus byte-identical default, cumulonimbus more opaque than cirrus, deck neither vanished nor blown out |
| probe-cloud-features.mjs | probe | ACTIVE | 2026-08-16 | 2 | B611 feature gate: asperitas/fluctus/arcus/virga each reshape the deck; OFF byte-identical under a frozen clock; toggle restores cleanly |
| probe-cloud-genus-morphology.mjs | probe | ACTIVE | 2026-08-16 | 8 | C13-16 GPU-half morphology acceptance: exact neutral-genus uniforms, zero-pixel default baseline, wind-aligned cirrus anisotropy w/ rotation control |
| probe-cloud-genus.mjs | probe | ACTIVE | 2026-08-16 | 3 | B408 V11 per-genus vertical-profile wiring: cirrus thinner, cumulonimbus denser, stratus distinct; cumulus/unset byte-identical to the pre-V11 default |
| probe-cloud-godray.mjs | probe | ACTIVE | 2026-08-16 | 2 | TAKRAM-9 cloud-aware god rays gate: transmittance mask dims the shaft, default-off is byte-identical, mask-producer liveness counter checked |
| probe-cloud-halfres-parity.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | B432 zero-drift gate: full-res default tier raw-canvas capture must be byte-identical across modified vs stash-reverted builds |
| probe-cloud-halfres.mjs | probe | ACTIVE | 2026-08-16 | 5 | B432 half-res tier quality gate: 0.5x march + bilateral upscale vs full-res at identical camera/time; no blocky pixelation or edge halos |
| probe-cloud-ibl-full.mjs | probe | ACTIVE | 2026-08-16 | 1 | B450 cloudsInReflections gate: opt-in per-face cloud march adds structure to the env cube; OFF byte-identical; temporal accumulation clean |
| probe-cloud-ibl-optout-revision.mjs | probe | ACTIVE | 2026-08-16 | 5 | C13-38 runtime gate: cloud revisions stay unconsumed while the march is opted out; opt-in consumes newest; OFF does one teardown refresh |
| probe-cloud-ibl.mjs | probe | ACTIVE | 2026-08-16 | 1 | B441 cloud-aware IBL gate: overcast dims + flattens model ambient; coverage without the cloudContributesIBL opt-in leaves IBL identical to clear |
| probe-cloud-lighting.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | V5 per-octave phase-folding acceptance: A/B vs stash-reverted pre-V5 build with W1/W2 floor gates (tonal range, lifted shadow floor, modest delta) |
| probe-cloud-lod-hoist-perf.mjs | probe | ACTIVE | 2026-08-16 | 6 | C13-39 GPU-timestamp A/B lanes for the density-LOD/domain hoist; codifies the repo's mandatory interleaved bundle-swap GPU-timing protocol |
| probe-cloud-lut-flagon.mjs | probe | ACTIVE | 2026-08-16 | 4 | B434 flag-on gate: physical aerial mode fogs distant clouds toward the real sky (sun-azimuth-tracking hue) and sky-lut ambient warms sunset undersides |
| probe-cloud-lut-parity.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | B434 zero-drift gate: default heuristic-aerial + constant-ambient path byte-identical across modified vs stash-reverted builds |
| probe-cloud-mammatus.mjs | probe | ACTIVE | 2026-08-16 | 3 | B555 mammatus gate: underside pouch carve visibly thins the deck, OFF byte-identical under a frozen clock, strength=0 restores the baseline |
| probe-cloud-morphology.mjs | probe | ACTIVE | 2026-08-16 | 1 | B439 morphology modes: curl erosion and perlin-worley cores A/B'd against an in-run default baseline, plus a stash-pair parity mode for default flags |
| probe-cloud-noisebake.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | V2 inert-bake gate: 3D noise baked + bound with the shader not sampling it — byte-identical to the pre-V2 stash build, bake ran, zero device errors |
| probe-cloud-noisecore.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | V3 keystone A/B vs the pre-V3 live-noise build: baked clouds render, sane cell count, faster frame, W1/W2 lighting survives on the baked path |
| probe-cloud-perf.mjs | probe | ACTIVE | 2026-08-16 | 11 | W5 adaptive-march A/B with pair-ID provenance: image within ~2% of the fixed march and a faster GPU-synced frame from empty-space skipping |
| probe-cloud-phase.mjs | probe | ACTIVE | 2026-08-16 | 3 | W1 dual-lobe Henyey-Greenstein gate: toward-sun silver-lining rim energy >= 1.25x the away-sun heading; single-run PASS bars |
| probe-cloud-planetary.mjs | probe | ACTIVE | 2026-08-16 | 7 | C13 planetary oracle: clouds-OFF/ON raw-canvas delta at every checkpoint along connected routes crossing the antimeridian, poles and altitude bands |
| probe-cloud-property-edit.mjs | probe | ACTIVE | 2026-08-16 | 6 | Regression: per-cloud property edits re-upload the billboard-cloud instance buffer within 2 frames, then settle with no further rebuilds |
| probe-cloud-reconstruction-attachments.mjs | probe | ACTIVE | 2026-08-16 | 5 | C13-09 edge acceptance: opt-in reconstruction attachments produce with pixel-inert output and exact liveBytes; cross-page noise-band method |
| probe-cloud-reconstruction-consume.mjs | probe | ACTIVE | 2026-08-16 | 6 | C13-10 legs B/C/D: march-emitted reconstruction depth consumed by the producer (targets 3->2), resize/tier lifecycle, interleaved A/B cost lanes |
| probe-cloud-remap.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | V4 mean-preserving erosion remap A/B vs the pre-V4 build: silhouette preserved at coverage 0.40, deck reads solid (fewer holes) at 0.85 |
| probe-cloud-rte.mjs | probe | ACTIVE | 2026-08-16 | 2 | B445 cloudHighPrecision gate: camera-relative RTE shell path renders essentially identical to the one-part world-space fallback (OFF/ON diff ~0) |
| probe-cloud-shadow-cascades.mjs | probe | ACTIVE | 2026-08-16 | 1 | Acceptance for the opt-in 3-cascade cloud shadow map: shadows exist, cascade sharpens near, far kept, OFF byte-identical. |
| probe-cloud-shadows-flagon.mjs | probe | ACTIVE | 2026-08-21 | 5 | Cloud cast-shadow ON/OFF capture over lit terrain, plus a C13-16 U2 CIRRUS acceptance mode with pinned clock/wind. |
| probe-cloud-shadows-parity.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Stash-based A/B proving default-OFF cloud-shadow consumers render byte-identically across the Batch 437 change. |
| probe-cloud-shadows-polar.mjs | probe | ACTIVE | 2026-08-21 | 9 | C13-06 pixel gate: cloud cast shadows must darken the ground band at 82N; fully pinned (P1-P8+P10) with bracketing control legs. |
| probe-cloud-special.mjs | probe | ACTIVE | 2026-08-16 | 2 | E3 acceptance: noctilucent/nacreous iridescent tints change the deck, differ from each other, OFF stays byte-identical. |
| probe-cloud-species.mjs | probe | ACTIVE | 2026-08-16 | 2 | E1 acceptance: lenticularis/fibratus/uncinus density shaping changes the deck as specified; species-unset path byte-identical. |
| probe-cloud-stbn-lod.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance for cloud march LOD dials (step growth, max ray distance): both reach the march, both true no-ops at defaults. |
| probe-cloud-temporal-rte.mjs | probe | ACTIVE | 2026-08-16 | 6 | C13-05 certification of the cloud temporal-history state machine via the CloudTemporalResolve UB upload: teleports, poles, resizes, culls. |
| probe-cloud-temporal.mjs | probe | ACTIVE | 2026-08-16 | 10 | Visual smoke check of temporal cloud accumulation at T1/T2 tiers: static convergence, mid-motion ghosting, post-motion settle. |
| probe-cloud-tier-resolver.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Stash-based byte-identity guard for the V1 CloudTierPreset scaffold (unread qualityFlags lane must not move pixels). |
| probe-cloud-tod.mjs | probe | ACTIVE | 2026-08-16 | 3 | Time-of-day cloud sun-color acceptance: dawn/dusk decks warm (R/B >= 1.15), noon neutral, via manual scene.render(jd) sun control. |
| probe-cloud-tour-sequences.mjs | probe | ACTIVE | 2026-08-16 | 2 | C13-01 evidence tail: fixture camera tours (OFF/ON cloud deltas per station) plus temporal-reset sequences with CPU/GPU metrics. |
| probe-cloud-tour.mjs | probe | ACTIVE | 2026-08-16 | 14 | Data-driven camera-tour harness capturing both cloud systems across type/location/angle/time scenes; procedural WebGPU, billboard both. |
| probe-cloud-u1-scaffold.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | U1 slice acceptance: CloudVolumetrics/CloudRenderMode API scaffold exists and, unused, leaves BILLBOARD renders byte-identical. |
| probe-cloud-u2-config.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | U2 slice byte-identity: config-indirection refactor must render identical ON-cloud hashes vs a HEAD-reverted build. |
| probe-cloud-u2-perf.mjs | probe | ACTIVE | 2026-08-21 | 4 | C13-16 U2 cross-bundle GPU-timestamp no-regression gate: interleaved bundle-swap A/B per cloud pass with drift sentinels. |
| probe-cloud-u3-toggle.mjs | probe | ACTIVE | 2026-08-16 | 3 | Standing guard: VOLUMETRIC CloudCollection publishes one resolved config and suppresses billboards; hidden/BILLBOARD/WebGL publish nothing. |
| probe-cloud-u4a-managed.mjs | probe | ACTIVE | 2026-08-16 | 4 | Standing guard for scene-owned defaultCloudCollection: four config producers re-homed onto .volumetric, defaults byte-identical. |
| probe-cloud-u8-offident.mjs | probe | ACTIVE | 2026-08-16 | 6 | Epic close-out standing guard: full volumetric flag surface is byte-inert in BILLBOARD mode on both backends, graceful WebGL no-op. |
| probe-cloud-volumetric-parity.mjs | probe | ACTIVE | 2026-08-16 | 5 | Both-backend billboard-cloud footprint comparison: WebGPU impostor blob vs WebGL raymarched core, bright-pixel bbox metrics. |
| probe-cloud-weather-flags.mjs | probe | ACTIVE | 2026-08-16 | 2 | U6 acceptance: weather dials reach the raymarcher via collection.volumetric; inert off the deck path, off-legs byte-identical. |
| probe-cluster-assign.mjs | probe | ACTIVE | 2026-08-16 | 2 | Compute-readback check of WebGPUClusterAssignRenderer: known 3-light scene yields expected per-cluster counts; dirty-skip works. |
| probe-cluster-bounds.mjs | probe | ACTIVE | 2026-08-16 | 3 | Compute-readback check of WebGPUClusterBoundsRenderer: per-cluster eye-space AABBs match a known projection; dirty-skip works. |
| probe-cluster-fs-consumer.mjs | probe | ACTIVE | 2026-08-16 | 1 | End-to-end Forward+ chain: bounds -> assign -> debug renderer; pixel colors confirm the FS cluster Z-slice mapping matches assign. |
| probe-clustered-demo-scene.mjs | probe | ACTIVE | 2026-08-16 | 3 | Replicates the Clustered Lighting Sandcastle demo scene and asserts a visible clustered contribution with 0 device errors. |
| probe-clustered-dispatcher.mjs | probe | ACTIVE | 2026-08-16 | 9 | Dispatcher lifecycle check: enable/disable packs activeLightCount, dirty-tracking skips, readbacks match, scene toggle exists. |
| probe-clustered-lights-resize.mjs | probe | ACTIVE | 2026-08-16 | 2 | Regression for stale cluster bins on stationary-camera resize/FOV change: bounds-only change must re-run assign; caching kept. |
| probe-clustered-litmat.mjs | probe | ACTIVE | 2026-08-16 | 3 | Clustered consumer on the primitive Mat*Lit path: lit MaterialAppearance primitive brightens under a PointLight when ON. |
| probe-clustered-matsweep.mjs | probe | ACTIVE | 2026-08-16 | 5 | Device-error sweep across all non-textured Mat*Lit shaders with clustered lighting on; each renders and differs from OFF. |
| probe-clustered-multifrustum.mjs | probe | ACTIVE | 2026-08-16 | 6 | Proves single-grid cluster binning is self-consistent and conservatively correct in a real multi-frustum scene (>=2 frustums). |
| probe-clustered-per-frame.mjs | probe | ACTIVE | 2026-08-16 | 7 | Per-frame hook check: lazy dispatcher construction, compute passes run with scene.lights, disable zeroes counts exactly once. |
| probe-clustered-phong.mjs | probe | ACTIVE | 2026-08-16 | 6 | Checks flat:false PerInstanceColorAppearance routes to the lit phong shader and the clustered consumer contributes visibly. |
| probe-clustered-visible.mjs | probe | ACTIVE | 2026-08-16 | 6 | Clustered consumer on the glTF Model PBR path: PointLight + clustered ON brightens the model center vs OFF by a measured margin. |
| probe-clustered-zero-work-route.mjs | probe | ACTIVE | 2026-08-16 | 6 | C9-16 API-counter gate: zero clustered GPU work at defaults on the moving route, with positive control and label-inventory guard. |
| probe-cmd-pushes.mjs | probe | ACTIVE | 2026-08-16 | 3 | Diagnostic: hooks frameState.commandList.push and tallies command pushes by pass over a settle window on the WebGPU viewer. |
| probe-cold-optics-hq.mjs | probe | ACTIVE | 2026-08-16 | 4 | Advanced ice-crystal optics acceptance (22+46 halos, dispersion, light pillars) with structural preconditions and gated verdicts. |
| probe-cold-optics-parity.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Stash-based parity capture: legacy cold-optics frame must be byte-identical between the B442 build and a stashed main build. |
| probe-cold-optics.mjs | probe | ACTIVE | 2026-08-16 | 2 | Base cold-optics acceptance: ON adds a ring at constant angular radius around the sun (radial profile) vs OFF on the same canvas. |
| probe-collection-pick.mjs | probe | ACTIVE | 2026-08-16 | 3 | Instrumented 7-link lane for the collection pick chain, naming the first dead link per target, with a Primitive positive control. |
| probe-collections-2dcv-morph.mjs | probe | ACTIVE | 2026-08-16 | 16 | Instant-morph placement audit: marker crops at the expected map location in 3D/2D/CV on WebGPU vs WebGL reference. |
| probe-collections-closeup.mjs | probe | ACTIVE | 2026-08-16 | 4 | Close-camera (600 m) parity check that Billboard/Point/Label render on WebGPU after the cull and clip-z fixes. |
| probe-collections-entity.mjs | probe | INVESTIGATION | 2026-08-16 | 7 | Disambiguation probe: do markers render via the entity API where dynamically-added raw collections did not, per mode and backend. |
| probe-collections-far-camera.mjs | probe | ACTIVE | 2026-08-16 | 11 | Far-camera log-depth gate: markers 1000 m above the globe at 220 km must render with log depth ON; kill-switch leg exercised. |
| probe-collections-morph-blend.mjs | probe | ACTIVE | 2026-08-16 | 5 | Animated-morph gate: markers track smoothly through morphTo2D/CV with no mid-morph vanish or completion pop, binned by morphTime. |
| probe-collections-msaa.mjs | probe | ACTIVE | 2026-08-16 | 4 | MSAA=4 pipeline regression: collection + ground-primitive pipelines must bake multisample count 4 (pre-B134 validation errors). |
| probe-collections-regression.mjs | probe | ACTIVE | 2026-08-16 | 10 | THE consolidated collections gate: five collections render, settled scenes upload nothing, mutations repaint in 2 frames, 0 errors. |
| probe-colorgrading-wired.mjs | probe | ACTIVE | 2026-08-16 | 6 | ColorGrading runtime-wiring acceptance: off by default, enable adds the pass, config swap re-grades, disable returns identical. |
| probe-compute-engine-wired.mjs | probe | ACTIVE | 2026-08-16 | 3 | Verifies WebGPUContext lazily instantiates the compute engine so dispatchCompute runs (visually inert by design; 0 errors). |
| probe-compute-instance-generic.mjs | probe | ACTIVE | 2026-08-16 | 7 | Feature-agnosticism check: a non-orbital Lissajous kernel renders, animates from the time scalar, threads BV + TAA velocity. |
| probe-compute-instance-pick.mjs | probe | ACTIVE | 2026-08-16 | 10 | GPU-resident compute-instances are pickable: scene.pick returns the right instanceIndex for three instances; empty space undefined. |
| probe-compute-instance-pickposition.mjs | probe | ACTIVE | 2026-08-16 | 7 | scene.pickPosition over compute-instances returns that instance's ECEF position on both backends; sync contract kept. |
| probe-compute-instance-webgl2-demos.mjs | probe | ACTIVE | 2026-08-16 | 6 | User-facing check: Orbital Catalog and SGP4 Sandcastle demos render and animate on both backends; right backend proven armed. |
| probe-compute-instance-webgl2.mjs | probe | ACTIVE | 2026-08-16 | 8 | WebGL2 cpuKernel fallback: matching WGSL/JS kernel pair renders, moves, and lands centroids within pixels of the WebGPU leg. |
| probe-confirm-inspector-sky.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Confirms the Weather Inspector grey-sky caveat was a standalone-shim artifact by replaying its config in the CesiumViewer boot. |
| probe-console-errors.mjs | probe | ACTIVE | 2026-08-16 | 2 | Minimal utility: loads the WebGPU viewer, settles 180 frames, prints only error/pipeline-failure console messages. |
| probe-contact-shadows.mjs | probe | ACTIVE | 2026-08-16 | 7 | Contact-shadows acceptance: wall base darkens when enabled, strength=0.5 darkens less than 1.0, all cells error-free. |
| probe-cpu-pass-profile.mjs | probe | ACTIVE | 2026-08-16 | 2 | Data collection for the render-bundle shortlist: runs CesiumDebug.cpuPassCost across named scenes, dumps per-pass CPU cost. |
| probe-cpu-sampling-profile.mjs | probe | ACTIVE | 2026-08-16 | 2 | V8 sampling profiler over CDP for the render loop on both backends, attributing self-time the per-pass profiler cannot see. |
| probe-csm-cast-dispatch.mjs | probe | ACTIVE | 2026-08-16 | 10 | Shadow-cast reachability: CSM cascade and single-map paths dispatch and produce umbra pixels, vs a WebGL reference cell. |
| probe-csm-globe-receive-trace.mjs | probe | INVESTIGATION | 2026-08-16 | 8 | Diagnostics-only trace of why globe-terrain CSM receive missed: projects a shadowed point via globe vs cast reconstructions. |
| probe-csm-soft-shadow.mjs | probe | ACTIVE | 2026-08-16 | 12 | CSM PCF softness gate: soft ON widens the penumbra vs hard OFF and lands in a WebGL-relative band; umbra floor is a ratio. |
| probe-culler-pool-decomp.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance for the culler-pool decomposition: exercises the extracted WebGPUContextCullerPool delegators; globe still renders. |
| probe-custom-shader-material-fields.mjs | probe | ACTIVE | 2026-08-16 | 2 | WGSL CustomShader exposes metalness/occlusion/normalEC and they re-drive lighting; untouched-fields shader stays identical. |
| probe-custom-shader-modify.mjs | probe | ACTIVE | 2026-08-16 | 3 | MODIFY_MATERIAL ordering acceptance: WGSL customShader runs pre-lighting, so constant diffuse gets shaded and converges with WebGL. |
| probe-custom-shader-translucency.mjs | probe | ACTIVE | 2026-08-16 | 5 | translucencyMode acceptance: TRANSLUCENT forces an opaque-authored model into the blend pass; INHERIT stays opaque. |
| probe-custom-shader-wgsl.mjs | probe | ACTIVE | 2026-08-16 | 2 | Native-WGSL CustomShader acceptance: user fragment reaches the output color, setUniform re-uploads live, off-gate clean. |
| probe-czml-bytes.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Loads a CZML Sandcastle demo forced to WebGPU and greps the console for writeBuffer byte-count and .includes error classes. |
| probe-darkness-quant.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Quantitative backend-brightness comparison: 32x32 pixel-grid RGB means/ratios classify darkening as uniform vs non-linear. |
| probe-daynight-terminator-law.mjs | probe | ACTIVE | 2026-08-16 | 9 | CLT-B1 premise verification: calibration-ladder measurement of the day/night terminator alpha law on both backends. |
| probe-daytime-ocean-brightness.mjs | probe | ACTIVE | 2026-08-16 | 3 | Day/night ocean-brightness acceptance over the Caribbean: mismatch under ~5% day / ~3% night, with per-term bypass attribution. |
| probe-debug-api.mjs | probe | ACTIVE | 2026-08-16 | 2 | End-to-end smoke of CesiumDebug.globeFragmentDebug: registry populated, each mode enables, screenshots captured. |
| probe-debug-snapshot.mjs | probe | ACTIVE | 2026-08-16 | 2 | Headless scene-state dump: tiles-to-render, pipeline-cache stats, and globe feature-renderer status from a settled viewer. |
| probe-decoupledscan-progress-guard.mjs | probe | ACTIVE | 2026-08-16 | 2 | Numeric compute check: the bounded-lookback prefix-sum watchdog preserves correct multi-workgroup scans and always terminates. |
| probe-demand-canvas-pass.mjs | probe | ACTIVE | 2026-08-16 | 8 | Certifies deferred canvas-pass demand-open: present, empty-scene clear, requestRenderMode retention, resize, and debug-overlay legs on WebGPU. |
| probe-depth-plane-horizon-oracle.mjs | probe | ACTIVE | 2026-08-16 | 8 | Horizon-occlusion oracle: points just before/beyond the geometric horizon must render/occlude, proven via GPU readback + pickAsync with a skip A/B. |
| probe-depth-plane-pick-matrix.mjs | probe | ACTIVE | 2026-08-16 | 3 | Runs the live WebGPU depth plane across SDR/HDR, MSAA, resize, and device-invalidation rebuild; records dynamic uniform offsets, fails GPU errors. |
| probe-depthfail-appearance.mjs | probe | ACTIVE | 2026-08-16 | 6 | Color-appearance depthFailAppearance parity: occluded box shades RED via the depth-fail pass; WebGPU red area within 0.6-1.6x of WebGL. |
| probe-depthfail-material.mjs | probe | ACTIVE | 2026-08-16 | 2 | Material depthFailAppearance parity + cull derivation: a closed depthFail must back-face cull like WebGL (pins the Batch-419 fix). |
| probe-determinism-check.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Captures one backend N times back-to-back to test whether run-to-run variance contaminated the polar-multi diff metric. |
| probe-determinism-kit.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance for lib/determinism-kit.mjs: pinned-clock recipe makes globe captures reproducible run-to-run (<0.05%) while the legacy recipe drifts. |
| probe-device-limits.mjs | probe | ACTIVE | 2026-08-16 | 3 | Dumps adapter-reported vs negotiated GPUDevice limits (e.g. the platform maxBindGroups ceiling) from a fresh browser. |
| probe-diag-demand-gates.mjs | probe | ACTIVE | 2026-08-16 | 3 | Disabled CPU pass profiler allocates no per-frame closures (render unaffected); enabled lane yields complete per-pass buckets via begin/endPass. |
| probe-diffusemap-primitive.mjs | probe | ACTIVE | 2026-08-16 | 1 | DiffuseMap material on a geometry primitive renders correctly on WebGPU after gaining its own shader pair (was corrupt via Image-shader struct). |
| probe-direct-draw-fb.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Draws a fullscreen triangle straight into the scene FB texture to bisect blank-scene bugs: FB broken vs content trashed downstream. |
| probe-disable-rrm.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Forces requestRenderMode off (continuous rendering) to check whether globe tiles then render — early blank-globe bisection. |
| probe-disc-size-orbit.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Measures Earth-disc pixel bounds per backend at orbit altitude, atmosphere off, to quantify the Batch-63 'WebGPU disc ~10% smaller' report. |
| probe-disk-bleed-scan.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Scans a vertical pixel strip on the Hello World demo to locate where the bluish off-disk halo starts, WebGPU vs WebGL. |
| probe-disk-bleed.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Samples globe-disk center RGB across affected demos to detect cyan atmosphere bleed onto the ocean (imagery wash-out). |
| probe-disk-extent-state.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Dumps camera/canvas/projection state on both backends for the disk-extent forensics of the wash-out investigation. |
| probe-dp46b-metadata.mjs | probe | ACTIVE | 2026-08-16 | 4 | Property-attribute scalar read via generated WGSL metadata codegen (struct Metadata + initializeMetadata): gradient proof, chunk asserts, off-parity. |
| probe-dp46c-metadata.mjs | probe | ACTIVE | 2026-08-16 | 2 | Property-TEXTURE metadata read in the model FS via the generated chunk's bindings + textureSample and the property-textures BGL variant. |
| probe-dp46d-metadata.mjs | probe | ACTIVE | 2026-08-16 | 2 | Property-TABLE metadata read via textureLoad(table, featureId); closes display-side structural-metadata parity (attr+texture+table). |
| probe-dp46e-pick-metadata.mjs | probe | ACTIVE | 2026-08-16 | 4 | scene.pickMetadata producer round-trip on WebGPU: WGSL pick write, async readback convergence, decode, WebGL cross-check. |
| probe-dp46f-metadata-demo.mjs | probe | ACTIVE | 2026-08-16 | 5 | DP-H46 closeout: the webgpu-structural-metadata-pick demo's asset serves, renders on WebGPU, and its pick path decodes values in dp46e ranges. |
| probe-draw-calls.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Instruments GPURenderPassEncoder to count real GPU draw calls vs silent no-ops — early 'are commands reaching the encoder?' bisection. |
| probe-draw-pipeline-labels.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Hooks setPipeline + draw to record which labeled pipelines actually draw during the scene FB pass. |
| probe-dusk-terminator.mjs | probe | ACTIVE | 2026-08-16 | 6 | Day/night terminator regression: pinned equinox clock, lit-vs-unlit hemisphere luminance ratio validates lightDirectionEC + nightAmbient floor. |
| probe-eclipse-cloud-response.mjs | probe | ACTIVE | 2026-08-21 | 8 | C13-41 Edge acceptance: eclipse-driven cloud radiance ratio, shadow contrast, and IBL refresh count — three pre-registered predictions. |
| probe-eclipse-globe-shadow.mjs | probe | ACTIVE | 2026-08-16 | 6 | C12-29 S5 browser proof: lunar shadow evaluated per globe fragment — visible/local during the 2024-04-08 eclipse, inert a day later, both backends. |
| probe-eclipse-scene-dimming.mjs | probe | ACTIVE | 2026-08-16 | 9 | C12-29 S2: scene-light + atmosphere dimming via eclipseSceneLightFactor, measured as within-step off/on/autoexposure luminance ratios. |
| probe-eclipse-sky-totality.mjs | probe | ACTIVE | 2026-08-16 | 5 | C12-29 S6 sky half: totality sky via algebraic recoveries — shell alpha from dual-background renders, star reveal, E3 flip, horizon twilight. |
| probe-eclipse-sun-fade.mjs | probe | ACTIVE | 2026-08-16 | 6 | C12-29 S1: continuous limb-darkened sun-billboard fade replaces the one-frame cull pop; sunset sweep, 2026 eclipse, toggle-off identity lanes. |
| probe-edge-authored-silhouette.mjs | probe | ACTIVE | 2026-08-16 | 7 | Authored silhouetteNormals accessor parity: WebGPU edge extractor consumes the signed-byte accessor like WebGL (numeric + visual lanes). |
| probe-edge-degenerate.mjs | probe | ACTIVE | 2026-08-16 | 5 | Degenerate-triangle edge parity (PR#13421 repro): extractor emits no NaN/Inf and classifies the zero-area face like WebGL; Node-side numeric. |
| probe-edge-display-mode-tri.mjs | probe | ACTIVE | 2026-08-16 | 4 | EdgeDisplayMode tri-mode signature parity: the three modes pairwise distinct on WebGPU and tracking WebGL's coverage ordering. |
| probe-edge-emitter.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Smoke-loads edge-visibility Sandcastle demos under forced WebGPU and dumps console/page errors — a per-demo error scan. |
| probe-edge-linestrings.mjs | probe | ACTIVE | 2026-08-16 | 1 | Regression guard: lineStrings-only primitives emit edges (pre-B316: zero); 7 Node-side asserts incl. restart delimiting, dedup, off-gate. |
| probe-edge-percolor.mjs | probe | ACTIVE | 2026-08-16 | 3 | Per-edge color parity: WebGPU edge WGSL gains a per-edge edgeColor vertex attribute; COLOR_0-blue GLB edges render blue on both backends. |
| probe-ellipsoid-mrt.mjs | probe | ACTIVE | 2026-08-16 | 4 | EllipsoidPrimitive writes real eye-space normals to G-buffer slot 1: AO must diverge between G-buffer and depth-fallback reads. |
| probe-ellipsoid-rte.mjs | probe | ACTIVE | 2026-08-16 | 6 | CSM ground-clamp uses the scene ellipsoid's radii: scaled-globe synth vs CPU rayEllipsoid reference + umbra IoU + WGS84 byte-identical off-gate. |
| probe-ellipsoidprim-logdepth.mjs | probe | ACTIVE | 2026-08-16 | 8 | Ray-marched EllipsoidPrimitive log-depth: kill-switch flips rebuild the pipeline, shell stays visible ON/OFF and at far camera, zero errors. |
| probe-ellipsoidprim-translucent.mjs | probe | ACTIVE | 2026-08-16 | 8 | Translucent EllipsoidPrimitive blends exactly once (cull back; ratio ~0.5x opaque, not 0.75x) + WebGL re-verify of the B269 matrix hoist. |
| probe-empty-scenes.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Sweeps demos suspected of rendering nothing on WebGPU: clear-color pixel sniff + primitive/tile counts per demo, both backends. |
| probe-enable-lighting-state.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Dumps globe.enableLighting state at default load on both backends — a one-question state check. |
| probe-entity-bulk-billboard-label.mjs | probe | ACTIVE | 2026-08-16 | 4 | Bulk billboard/label fast lane: hundreds of static entities render + pick on both backends, route through the flat-buffer lane, dynamics update. |
| probe-entity-bulk.mjs | probe | ACTIVE | 2026-08-16 | 8 | BulkPointVisualizer fast lane: tens of thousands of static points render on both backends, pick returns the Entity, per-frame cost drops. |
| probe-entitycluster-gpu.mjs | probe | ACTIVE | 2026-08-16 | 7 | GPU screen-space declutter: clusters form, zoom-out merges, parity with CPU KDBush counts, dispatcher ran, scaling advantage, zero errors. |
| probe-env-aerial-ms.mjs | probe | ACTIVE | 2026-08-16 | 6 | envMapMultiScatter dual mode: flag-off byte-identity dump for the stash gate + flag-on deltas (cube warms toward sun, aerial haze matches sky). |
| probe-env-background-clear.mjs | probe | ACTIVE | 2026-08-16 | 6 | Background-clear response gate: scene.backgroundColor must reach the canvas as env content is progressively removed (deferred-clear drop defect). |
| probe-env-moon.mjs | probe | ACTIVE | 2026-08-16 | 9 | Moon parity: full-disc position/texture-variance/bbox/diff gates for the model-space RTE fix, plus a crescent-phase terminator lane. |
| probe-env-parallax.mjs | probe | ACTIVE | 2026-08-16 | 1 | Box/sphere parallax-corrected localized reflections: OFF deterministic and unchanged, each proxy changes the mirror reflection, zero errors. |
| probe-env-pass-matrix.mjs | probe | ACTIVE | 2026-08-16 | 8 | Environment-element independence matrix: any subset of skybox/stars/atmosphere/sun/moon/globe renders exactly that subset, matching WebGL. |
| probe-env-skybox-stars.mjs | probe | ACTIVE | 2026-08-16 | 11 | SkyBox star-cubemap parity isolated from the StarField catalog: density/luminance family match + flipY pattern correlation; repaired 2026-08-07. |
| probe-env-temporal-reset.mjs | probe | ACTIVE | 2026-08-16 | 1 | Env-cube temporal behavior: small sun delta crossfades (EMA between A and B), large delta resets history (snaps to the new single-frame capture). |
| probe-env-temporal.mjs | probe | ACTIVE | 2026-08-16 | 2 | Opt-in envMapTemporalAccumulation: OFF allocates nothing and stays byte-identical; ON converges to the OFF look and resets on sun jumps. |
| probe-error-gate-selftest.mjs | probe | ACTIVE | 2026-08-16 | 2 | Self-test of the shared webgpu-error-gate lib: clean run stays empty, injected validation error is caught, device.destroy teardown is ignored. |
| probe-error-pipeline.mjs | probe | ACTIVE | 2026-08-16 | 3 | Flat-magenta fallback for a failed model PBR pipeline: forced-failure hook renders magenta instead of a silent hole; hook off renders normally. |
| probe-exag-water-streaks.mjs | probe | ACTIVE | 2026-08-16 | 5 | Regression lock: no saturated blue water streaks at EXAG=10 Himalaya with atmosphere off, plus cross-backend water color parity with it on. |
| probe-exaggeration-3d.mjs | probe | ACTIVE | 2026-08-16 | 5 | SCENE3D vertical-exaggeration didn't-break guard after the B362 switch to the WebGL attribute-based height offset; oblique Himalaya EXAG=10. |
| probe-exaggeration-cv.mjs | probe | ACTIVE | 2026-08-16 | 7 | Columbus-view / morph vertical exaggeration ungated in GlobeTerrain.wgsl: WebGPU CV relief must match WebGL instead of rendering flat. |
| probe-farcam-distortion.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Reproduces far-camera globe distortion + mesh tear: height/pitch/atmosphere sweep with disc-silhouette ratio and concave-bite tear detection. |
| probe-farcam-isolation.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Long-fixed-settle retest of far-camera views proving the 'cage/ring' was a partially-materialized capture artifact, not a precision bug. |
| probe-fb-after-draws.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Hooks render-pass end to copy the scene FB texture to a readback buffer, proving whether draws write pixels or get trashed downstream. |
| probe-fb-config.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Dumps framebuffer/context configuration state from a forced-WebGPU Hello World load via the legacy Sandcastle shim. |
| probe-feature-id-texture.mjs | probe | ACTIVE | 2026-08-16 | 5 | Unified per-fragment feature-ID G-buffer resolvable in-shader: FeatureIdResolve.wgsl recolors globe + billboard IDs to distinct colors. |
| probe-fft-ocean.mjs | probe | ACTIVE | 2026-08-16 | 4 | Opt-in FFT spectral ocean: OFF byte-identity across sessions, globe-hidden ON capture paints a non-empty patch, two ON frames differ (waves). |
| probe-flat-polygon-grid-material.mjs | probe | ACTIVE | 2026-08-16 | 1 | Flat (height-0) polygon with a Grid MaterialAppearance shows the pattern on WebGPU (st generation), with an extruded-polygon off-gate. |
| probe-fleet-contract.spec.mjs | spec | ACTIVE | 2026-08-21 | 15 | Authoring-time probe safety contract: every probe must carry watchdog + try/finally close; mutant-tested detectors, shrink-only allowlist. |
| probe-flowfield-wind.mjs | probe | ACTIVE | 2026-08-16 | 2 | GPU wind-particle flow-field layer over the offline GFS sample: show=false byte-identical off-gate, ON renders particles, advection moves. |
| probe-fog-auto-vpt.mjs | probe | ACTIVE | 2026-08-16 | 1 | volumetricFog quality='auto' resolves a hardware tier via VisualPerformanceTargetService only when VPT is opted in; default stays 'low'. |
| probe-fog-ibl-ambient.mjs | probe | ACTIVE | 2026-08-16 | 1 | Opt-in sky-LUT/IBL fog ambient: warms at low sun, neutral/brighter at high sun; a human reads the PNGs and band stats. |
| probe-fog-ms-toggle.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Single-session multiScatter on/off toggle eliminating cross-session tile nondeterminism during the FOG-MS diagnosis. |
| probe-fog-ms.mjs | probe | ACTIVE | 2026-08-16 | 3 | Opt-in multi-octave multiple scattering in the froxel-fog in-scatter pass: parity/off/on modes; dense mist reads as a lit volume, no blowout. |
| probe-fog-state.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Dumps fog enabled/density/uniform state on both backends from the Particle System demo via the legacy Sandcastle shim. |
| probe-fog-temporal.mjs | probe | ACTIVE | 2026-08-16 | 2 | Opt-in froxel-fog temporal reprojection + blue-noise jitter: parity mode, static convergence to stable low noise, moving camera with no ghosting. |
| probe-force-red.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Forces globeFragmentDebug('force-red') on both backends at a 12 Mm view and measures red pixel coverage to prove globe FS rasterization reaches output |
| probe-fork41-occlusion-v2.mjs | probe | ACTIVE | 2026-08-16 | 3 | Hi-Z occlusion cull-correctness gate in a genuinely occludable scene (lid over 2500 boxes): cull actually culls, pixels unchanged, no device errors |
| probe-fork41-occlusion.mjs | probe | ACTIVE | 2026-08-16 | 6 | Hi-Z occlusion no-false-cull gate: dense sky-overhanging boxes must never be culled; asserts dispatches run, default-safe image, zero errors |
| probe-frustum-count-3d.mjs | probe | ACTIVE | 2026-08-16 | 16 | Records scene.numberOfFrustums + per-frustum ENVIRONMENT/GLOBE bins on both backends at 3 altitudes to gate the ENV-command frustum-binning fix |
| probe-fs-debug-modes.mjs | probe | ACTIVE | 2026-08-16 | 1 | Captures each globe-fragment debug visualization (uv/alpha/sample0/mip4/...) at a fixed view for manual imagery/UV correctness inspection |
| probe-fullscreen-sky-demo.mjs | probe | ACTIVE | 2026-08-16 | 2 | Boots the WebGPU Fullscreen Sky gallery demo standalone and verifies fullscreen-vs-shell sky parity, day/night darkening, zero device errors |
| probe-gamma-chain.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Read-only dump of the gamma/output chain on both backends: canvas attrs, WebGPU presentation format, active PP stages, HDR/tonemapper state |
| probe-gbuffer-enabled.mjs | probe | ACTIVE | 2026-08-16 | 5 | Flips scene.deferredLighting on and asserts the G-buffer producer runs with zero visible pixel change (consumers land in a later slice) |
| probe-gbuffer-visualize.mjs | probe | ACTIVE | 2026-08-16 | 6 | Renders CesiumDebug.showGBufferNormals() and checks the G-buffer normal texture reads as a proper RGB-mapped sphere with magenta sentinels |
| probe-geojson-holes.mjs | probe | ACTIVE | 2026-08-16 | 5 | Pixel-samples fill vs hole points to prove GeoJsonPrimitive interior rings are cut out, and that debugShowBoundingVolume draws on both backends |
| probe-geojson-primitive.mjs | probe | ACTIVE | 2026-08-16 | 7 | Loads a mixed GeoJSON FeatureCollection through GeoJsonPrimitive on both backends; gates capacity math (ERR_CAPACITY) and cross-backend pixel diff |
| probe-globe-bindgroup-cache.mjs | probe | ACTIVE | 2026-08-16 | 7 | Gates the globe per-tile bind-group cache: creations settle to ~0, spike+resettle on pan, globe visibly renders, zero validation errors |
| probe-globe-bundle-cost.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | TEMP A/B measurement of the inline globe render-bundle's per-frame CPU cost — the decision input for the cache-vs-drop call |
| probe-globe-clippoly-geodetic.mjs | probe | ACTIVE | 2026-08-16 | 4 | Globe clipping-polygon parity: the polygon hole must exist on both backends and the clip boundary must align (geodetic SDF convention fix) |
| probe-globe-default-limits.mjs | probe | ACTIVE | 2026-08-16 | 7 | Gates globe rendering on a device pinned to WebGPU default limits (16 sampled textures): reduced 4-slot imagery layout + multi-pass blend path |
| probe-globe-effects-handle-toggle.mjs | probe | ACTIVE | 2026-08-16 | 4 | Oracle for the per-frame globe-effects bind-group memo: clipping ON-OFF-ON must carve, restore, and re-carve terrain with zero stale-handle errors |
| probe-globe-farzoom.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic re-bucketing of the far-zoom 'GPU brighter' interior blobs with ground atmosphere toggled, attributing drape vs imagery mip/LOD-bias |
| probe-globe-hdr-gamma.mjs | probe | ACTIVE | 2026-08-16 | 4 | Gates the globe sRGB-to-linear decode under the HDR canvas-output path via known-gray imagery: SDR byte-identical off-gate, HDR single-decode means |
| probe-globe-material.mjs | probe | ACTIVE | 2026-08-16 | 2 | Runs a legacy Sandcastle gallery demo (default Globe Materials) under a forced-renderer Viewer shim; reports console errors and pixels |
| probe-globe-pick-h44.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gates opt-in WebGPU globe terrain picking (globe.pickable): default stays unpickable, foreground picks unaffected, WebGL leg unaffected by the flag |
| probe-globe-pipeline-readiness.mjs | probe | ACTIVE | 2026-08-16 | 7 | Measures whether the WebGPU globe's async pipeline-miss tile skip produces user-visible holes vs WebGL under a healthy event loop |
| probe-globe-polar-stretch.mjs | probe | ACTIVE | 2026-08-16 | 8 | Acceptance for the Mercator-reprojection double-flip fix: ice-centroid/area/shift metrics + mismatch at mid/far/extreme zooms, WebGL vs WebGPU |
| probe-globe-rasterizes.mjs | probe | ACTIVE | 2026-08-16 | 3 | Smoke check that the WebGPU globe rasterizes at all: canvas coverage, luminance, color histogram vs WebGL, device-error gate |
| probe-globe-translucency.mjs | probe | ACTIVE | 2026-08-16 | 8 | globe.translucency per-fragment alpha parity: off-gate at defaults, see-through planet from space, half-alpha terrain oblique — WebGL vs WebGPU |
| probe-globe-underground.mjs | probe | ACTIVE | 2026-08-16 | 9 | globe.undergroundColor + alphaByDistance tint parity: above-ground off-gate plus red-tint and default underground camera scenarios |
| probe-gltf-points-mode.mjs | probe | ACTIVE | 2026-08-16 | 4 | Gates glTF mode-0 POINTS rendering: point-list topology threaded through the WebGPU model pipeline; coverage/color/centroid parity vs WebGL |
| probe-gp-pipeline.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | GroundPolyline bring-up deep-dump: UBO floats, interleaved vertices, red-pixel footprint — from when the shadow volume rendered nothing |
| probe-gp-vs-output.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | GroundPolyline rasterization discriminator: forces the FS to opaque cyan to separate 'VS produces geometry' from 'volume not rasterizing' |
| probe-gpu-culler-consumers.mjs | probe | ACTIVE | 2026-08-16 | 4 | Static source-scan gate: all four GPU dispatchers (gpuCull/HiZ/GPUSortKeys/PointCloudSort) must keep a wired consumer and an activation gate |
| probe-gpu-sort-auto.mjs | probe | ACTIVE | 2026-08-16 | 2 | Gates the production auto-enable heuristic for the GPU opaque sort consumer: auto-applies above threshold, off-gates for 'never' and small scenes |
| probe-gpu-sort-consume.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gates the GPU sort consumer: readback is a valid permutation, monotonic in the recomputed 64-bit key, applied, and pixel-neutral ON vs OFF |
| probe-gpu-timestamp-profiler.mjs | probe | ACTIVE | 2026-08-20 | 7 | Certification lane for GPU-timestamp unique-sample accounting: drained readbacks, closed sample ledger, coverage+unprofiled ratios reconstruct 1.0 |
| probe-grid-multizoom.mjs | probe | ACTIVE | 2026-08-16 | 4 | Gates the WGSL Grid material's constant-pixel-width antialiased lines across nadir zooms + an oblique view; WebGL held to the same constancy bar |
| probe-ground-atmosphere.mjs | probe | ACTIVE | 2026-08-16 | 8 | Deletion-verify gate: separate ground-atmosphere renderer gone (FR key 29 retired) while the in-shader GlobeTerrain path renders and contributes |
| probe-ground-fog.mjs | probe | ACTIVE | 2026-08-16 | 9 | Gates the froxel ground-fog own-activation path: config echo, ON-lane dispatch, lower-band brightening vs an OFF noise floor — hard exit codes |
| probe-ground-polyline-logdepth.mjs | probe | ACTIVE | 2026-08-16 | 4 | Gates the GroundPolyline classifier's log-depth reversal: magenta draped line at a far camera must match WebGL within 25% with the FR cache built |
| probe-ground-view-env.mjs | probe | ACTIVE | 2026-08-16 | 5 | Numerically gates three ground-level divergences vs WebGL: daytime sky brightness, sun disk vs atmosphere ordering, and globe baseColor consumption |
| probe-groundprim-textured-classify.mjs | probe | ACTIVE | 2026-08-16 | 7 | Gates textured GroundPrimitive classification (Stripe/Checkerboard/Grid/Image) on WebGPU with a GLOBE-pass readiness gate that kills the B595 race |
| probe-gsplat-classification-depth.mjs | probe | ACTIVE | 2026-08-21 | 1 | Counter-assert WebGPU classification-depth pipeline selection and dual-backend polygon placement on the tower splat surface, with a terrain-return suppression control. |
| probe-gsplat-frame-variance.mjs | probe | INVESTIGATION | 2026-08-21 | 2 | Runs pre-registered D1-D5 gsplat variance discriminators without changing the mutant-pinned 0.050% bar. |
| probe-gsplat-parity.mjs | probe | ACTIVE | 2026-08-16 | 9 | Dual-mode gsplat harness: certifies attributable WebGPU absence pre-G3, scores presence with --expect-webgpu; exit-gate instrument for GSPLAT rows |
| probe-h12-longsettle.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Answered whether the 12 Mm 'cage' (dark radial wedge gaps) was a real render defect or a coarse-LOD probe-settle artifact via a fixed long settle |
| probe-hdr-canvas-output-decomp.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance for the WebGPUContext canvas-config extraction: SDR off-gate, HDR toggle via extracted setHDRCanvasOutput, fallback-listener API behavior |
| probe-hdr-pick-format-closure.mjs | probe | ACTIVE | 2026-08-16 | 5 | Fleet-wide object-ID pick matrix across SDR/HDR, MSAA 1/4, runtime HDR flip and resize: every family must return its exact owner with zero errors |
| probe-hdr-pp-math.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gates HDR-aware ColorGrading+FXAA on the tonemap-bypass path: SDR byte-identical vs baseline, stages run in HDR with tonemap absent, WGSL compiles |
| probe-hdr-toggle-invalidation.mjs | probe | ACTIVE | 2026-08-16 | 3 | Gates mid-session scene.highDynamicRange toggles: pipelines/bundles must be rekeyed so post-toggle frames emit zero format-mismatch validation errors |
| probe-heat-shimmer.mjs | probe | ACTIVE | 2026-08-16 | 2 | WebGPU-only heat-shimmer proof: ON-vs-OFF warp concentrated in the ground band, animated between frames, zero OFF-vs-OFF drift |
| probe-hello-sc-clean.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Env-layer toggle matrix (skyAtmosphere/groundAtmosphere/fog/skyBox) over Sandcastle Hello World to isolate which layer caused a sky color divergence |
| probe-hello-sc-wgl.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | WebGL reference leg of the Hello World sky investigation: raw gallery boot, env layers off, samples two fixed ocean/continent pixels |
| probe-hello-sc.mjs | probe | ACTIVE | 2026-08-16 | 2 | Boots legacy Sandcastle Hello World forced onto WebGPU via a Viewer-patching shim; screenshots and pixel-samples to verify the demo path renders |
| probe-hiz-occlusion-consumer.mjs | probe | ACTIVE | 2026-08-16 | 5 | Dense 3600-box scene crossing the Hi-Z gate: polls highDensityCull() for activation/dispatch/filtering and captures both backends for over-cull |
| probe-hiz-occlusion-control.mjs | probe | ACTIVE | 2026-08-16 | 4 | Control leg: same 3600-box scene with gpuCullingHint='never' to prove any dense-scene failure is the Hi-Z compute path, not primitive count |
| probe-hiz-tile-occlusion.mjs | probe | ACTIVE | 2026-08-16 | 5 | Gates the OBB bounding-volume fix in Hi-Z SOA population: no NaN radii for region-bounded tilesets, radii match sphere-from-OBB, no tileset vanish |
| probe-i3dm-instance-jitter.mjs | probe | ACTIVE | 2026-08-16 | 4 | i3dm instance-translation RTE precision: pixel-stable across frames and WebGPU placement matches WebGL after the high/low translation split |
| probe-ibl-hdr.mjs | probe | ACTIVE | 2026-08-16 | 1 | Flag-ON improvement proof for HDR environment maps + HQ IBL prefilter: brighter peak specular and fewer firefly outliers than the LDR default path |
| probe-imagery-overlay.mjs | probe | ACTIVE | 2026-08-16 | 4 | Regression check that the reprojection alpha=1.0 fix didn't crush transparent imagery overlays: tile-coordinate labels over Bing on both backends |
| probe-imagery-tex.mjs | probe | ACTIVE | 2026-08-16 | 5 | Asserts a loaded tile has a REALIZED WebGPU imagery GPUTexture via the per-imagery dual-texture fields and the renderer's _imageryTextureCache |
| probe-imagery.mjs | probe | ACTIVE | 2026-08-16 | 3 | Diagnostic dump of imagery-layer/tile state (layers, skeletons, provider readiness) on the WebGPU viewer after a settle loop |
| probe-khr-extensions-parity.mjs | probe | ACTIVE | 2026-08-16 | 2 | Loads each KHR material-extension model on both backends in fresh pages; gates renders, GPU errors, and the DOM error panel (shader compile failures) |
| probe-khr-extensions.mjs | probe | ACTIVE | 2026-08-16 | 4 | Six KHR materials extensions end-to-end: model loads, pipelines draw errorless, and material-UB factor slots contain packed values at audited offsets |
| probe-khr-lights-punctual.mjs | probe | ACTIVE | 2026-08-16 | 4 | Verifies KHR_lights_punctual extraction: 3 lights resolved per-node into model.lightsFromGltf and packed into the per-model light UBO without errors |
| probe-khr-meshopt.mjs | probe | ACTIVE | 2026-08-16 | 4 | v1.143 merge acceptance: KHR_meshopt_compression assets load via the lazy MeshoptDecoder, render on both backends, and stay under the parity threshold |
| probe-ktx2-transcoder-formats.mjs | probe | ACTIVE | 2026-08-16 | 4 | Standing regression guard that loadKTX2 requires the per-context immutable ktx2TranscodeTargets record and resolves a real .ktx2 on WebGPU |
| probe-lake-water-mask.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance for opt-in globe.lakeWaterMask (Natural Earth lake polygons OR-composited into the water mask): off-gate, effect, and parity legs |
| probe-large-lake-water.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Root-caused flat Great Lakes by querying the terrain provider's waterMask directly at lake/ocean/land points, plus a render check on both backends |
| probe-limb-halo-width.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gates isolated SkyAtmosphere shell limb-width parity, and reports (no gate) the tracked ground-atmosphere drape limb residual on the full scene |
| probe-litmat-mrt.mjs | probe | ACTIVE | 2026-08-16 | 5 | Extruded lit-material polygon through WebGPUPrimitiveCommands: zero device errors and a measurable deferred/AO signal from the polygon's MRT writes |
| probe-live-weather-demo.mjs | probe | ACTIVE | 2026-08-16 | 2 | Verifies the live-EDR weather demo plumbing to the network boundary: provider wired through /proxy, graceful fallback + status panel on fetch failure |
| probe-lod-case-paths.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Polar altitude sweep dumping each tile's reprojection case path (useWebMercatorT/reprojected/ancestor) to find the LOD-dependent imagery residual |
| probe-logdepth-globe.mjs | probe | ACTIVE | 2026-08-16 | 3 | Globe log-depth producer check: _logDepthWriteEnabled off is inert, on recompiles the LOG_DEPTH variant and still renders with zero device errors |
| probe-logdepth-payoff.mjs | probe | ACTIVE | 2026-08-16 | 3 | A/B: does the renderer-wide log-depth master switch fix the ground-classification far-corner precision artifact? Variance gate + STRUCTURAL guard. |
| probe-logdepth-pp-sliceb.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance for log-depth reverse in depth-reading post-FX (AO/GTAO, DoF, GodRay): armed reverse changes pixels; forced-off + effects-off gates. |
| probe-logdepth-pp-slicec.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance for log-depth reverse in SSR + ContactShadows view reconstruct; consumer-only A/B via disarmed encode-frustum stash; off-gate. |
| probe-logdepth-zfight.mjs | probe | ACTIVE | 2026-08-16 | 8 | Mat/PBR/Basic primitive log-depth z-fight gate: box pixels lost to terrain bleed, master switch ON vs OFF, plus below-surface negative control. |
| probe-ltc-area-light.mjs | probe | ACTIVE | 2026-08-16 | 4 | C6 LTC area-light acceptance: RectAreaLight brightens a glTF model on WebGPU; zero-area-light off-gate byte-ish identical; 0 device errors. |
| probe-magenta-clear.mjs | probe | ACTIVE | 2026-08-16 | 2 | Diagnostic: forces the scene-FB clear to magenta to classify black-canvas causes (no-op draws vs black writes vs broken downstream blit). |
| probe-mainthread-encode-ceiling.mjs | probe | INVESTIGATION | 2026-08-16 | 6 | Go/no-go spike: fits main-thread encode+upload ms vs N (10k-250k moved points/frame) for 60/30fps ceilings gating the ECS-on-worker phase. |
| probe-mars-diag.mjs | probe | ACTIVE | 2026-08-16 | 2 | Minimal loader for the Mars Sandcastle demo under a WebGPU viewer shim, collecting '[diag' console logs — alternate-ellipsoid diagnostics. |
| probe-matappearance-parity.mjs | probe | ACTIVE | 2026-08-16 | 3 | Verifies WGSL Lit shaders use czm_phong-equivalent lighting: luminance + top-vs-side ratio parity on a lit extruded polygon, both backends. |
| probe-metadata-mat.mjs | probe | ACTIVE | 2026-08-16 | 5 | Proves MAT3/MAT4 property attributes transport all 9/16 components to WGSL via the widened slot-9 layout; per-face palette readout, both backends. |
| probe-metadata-multicomponent.mjs | probe | ACTIVE | 2026-08-16 | 5 | Proves VEC2/3/4 property attributes transport every component (vec4 slot-9), with debug paint of authored per-face RGB; debug-off gate. |
| probe-metadata-table-instance.mjs | probe | ACTIVE | 2026-08-16 | 3 | Property tables keyed by instance feature IDs on WebGPU: 4-instance debug-paint palette, WGSL path asserts, off-gate, WebGL reference. |
| probe-metadata-table-texture.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance: property tables keyed by texture/implicit feature IDs on WebGPU + cross-backend feature-pick and pickMetadata-undefined parity. |
| probe-metadata-uint16.mjs | probe | ACTIVE | 2026-08-16 | 5 | Proves UINT16/UINT32 property-texture metadata round-trips the multi-byte little-endian unpack: exact pickMetadata quantization, both backends. |
| probe-mip-debug.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | One-off: compares globeFragmentDebug mip modes at orbit altitude to tell whether the imagery mip chain is read or the gap is LOD selection. |
| probe-mipmap-check.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | One-off: inspects the WebGPU globe imagery cache to confirm uploaded tile textures allocate mipLevelCount > 1. |
| probe-mode-roundtrip.mjs | probe | ACTIVE | 2026-08-16 | 4 | Regression: SCENE3D renders correctly after round-trips through 2D/Columbus (user-reported split-globe artifact on return to 3D). |
| probe-model-aniso-ibl.mjs | probe | ACTIVE | 2026-08-16 | 2 | KHR_materials_anisotropy IBL bent-normal parity: WebGL-vs-WebGPU pixel diff on TestKhrAnisotropy with the WebGPU error gate armed. |
| probe-model-appearance-demo.mjs | probe | ACTIVE | 2026-08-16 | 5 | End-to-end check of the webgpu-model-appearance demo scenario: signature-pixel asserts for color/silhouette/split, off-gate identity, thumbnail. |
| probe-model-capture-camera-parity.mjs | probe | ACTIVE | 2026-08-16 | 1 | OFF-parity gate for env-scene-capture models: the packCameraUniforms eye-swap is a no-op on-screen across 3D/2D/CV + multi-view. |
| probe-model-capture-face-zoom.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | One-off full-res readback of one env-cube face so the captured model is visible by eye; occlusion eyeball check. |
| probe-model-capture-reflection.mjs | probe | ACTIVE | 2026-08-16 | 1 | ON-path acceptance: the model capture pass renders an emissive glTF into env-cube faces over globe+sky with occlusion; ON/OFF faces, 0 errors. |
| probe-model-color.mjs | probe | ACTIVE | 2026-08-16 | 8 | model.color acceptance: HIGHLIGHT/REPLACE/MIX tint parity per channel across backends, mode sanity, off-gate identity; fresh page per capture. |
| probe-model-ibl.mjs | probe | ACTIVE | 2026-08-16 | 8 | Model IBL parity: split-sum BRDF LUT consumption + world-anchored reflection frame at two camera headings, with a specular liveness control. |
| probe-model-instance-bg-cache.mjs | probe | ACTIVE | 2026-08-16 | 9 | Runtime gate: the per-primitive model group-2 bind-group cache creates no new merged instance groups after settle, retains cached identities. |
| probe-model-ktx2-ibl.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance: authored KTX2 specular env maps load + prefilter on WebGPU — load proof, WebGL parity, consume-vs-procedural delta, 0 errors. |
| probe-model-mip-inspect.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | C10-05 evidence: walks model material textures to report allocation path (stub vs fallback), mipLevelCount/dims, sampler min-filter. |
| probe-model-mip-shimmer.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | C10-05 pre/post evidence: high-frequency energy over a minified model texture per backend — mip-0 aliasing shimmer vs trilinear smoothness. |
| probe-model-mrt.mjs | probe | ACTIVE | 2026-08-16 | 4 | Model G-buffer verification: 4-cell ao-x-deferred matrix on Milk Truck; perturbed normals + roughness in slot 1 widen the AO signal. |
| probe-model-pbr-audit.mjs | probe | ACTIVE | 2026-08-16 | 8 | Broad model PBR audit across skinned/instanced/unlit/textured assets: 0 device errors, material-UB sizes/alignment, passes invoked. |
| probe-model-pbr-ibl-parity.mjs | probe | ACTIVE | 2026-08-16 | 6 | At-rest neutral-model PBR parity: luminance/tint/flatness gap between backends; D1 atmosphere-derived env sky closed the residual to ~1%. |
| probe-model-project2d.mjs | probe | ACTIVE | 2026-08-16 | 5 | projectTo2D acceptance: accurate per-vertex 2D/CV reprojection footprint parity vs WebGL for a large-arc model; non-empty; 3D off-gate. |
| probe-model-scene-modes.mjs | probe | ACTIVE | 2026-08-16 | 10 | Acceptance: mode-aware model matrix + bounding volume in SCENE2D/COLUMBUS_VIEW matches the WebGL footprint; SCENE3D off-gate parity. |
| probe-model-scene2d-idl.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance: an antimeridian-straddling model in SCENE2D emits the derived wrapped 2D command on WebGPU (both map edges); off-IDL off-gate. |
| probe-model-scene2d-stage-guard.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance: the 2D-stage typedArray strip routes through requiresVertexTypedArrayRetention — kept on WebGPU, stripped on WebGL, unrun in 3D. |
| probe-model-silhouette.mjs | probe | ACTIVE | 2026-08-16 | 5 | model.silhouette acceptance: red rim parity across backends (stencil two-pass semantics) + silhouetteSize=0 off-gate identity, zero rim pixels. |
| probe-model-splitter.mjs | probe | ACTIVE | 2026-08-16 | 3 | model.splitDirection acceptance: LEFT split hides the correct half identically on both backends; NONE off-gate renders the full model. |
| probe-model-taa-msaa.mjs | probe | ACTIVE | 2026-08-16 | 5 | Device-error canary: detects velocity-pipeline sampleCount mismatch under TAA + MSAA=4 (multisampled pipeline vs 1-sample velocity target). |
| probe-model-tangentgen.mjs | probe | ACTIVE | 2026-08-16 | 4 | Verifies the derivative-tangent fallback for tangentless normal-mapped glTF: 0 device errors + both backends render; A/B signal documented. |
| probe-moon-atmosphere-appearance.mjs | probe | ACTIVE | 2026-08-16 | 8 | C12 moon-wave acceptance: disc extinction+inscatter compositing, Lommel-Seeliger + opposition surge; 3 derived-epoch lanes, WebGL vs WebGPU. |
| probe-moon-atmosphere.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance: the moon dims + reddens through horizon slant-path extinction at low altitude on both backends; orbit config is the off-gate. |
| probe-moon-globe-depth-occlusion.mjs | probe | ACTIVE | 2026-08-16 | 6 | C12-37 physical-depth oracle: derived moon-near/earth-near/crossing lanes certify moon-vs-globe depth routing; immutable UUID run artifacts. |
| probe-moon-lola-relief.mjs | probe | ACTIVE | 2026-08-16 | 5 | C12-25 LOLA lunar normal-map acceptance: terminator ON/OFF relief, full-phase near-invisibility, cross-backend parity, OFF identity. |
| probe-moon-mip-motion-edge.mjs | probe | ACTIVE | 2026-08-21 | 10 | C12-33 paired normal/force-lod0 motion-shimmer envelope, seam-image review, and WebGL/WebGPU parity; does not claim observed mip or texture-LOD selection. |
| probe-moon-phase-gate.mjs | probe | ACTIVE | 2026-08-16 | 6 | C11-176b acceptance: Moon.wgsl phaseGate blackout defect — derived-epoch crescent/night-full lanes with projected-disc ROI metrics. |
| probe-moon-sunlit.mjs | probe | ACTIVE | 2026-08-16 | 6 | Regression pin: the moon shows sun-relative shading (limb darkening, graded terminator, displaced lit centroid) on both backends. |
| probe-moon-texture-lifecycle-edge.mjs | probe | ACTIVE | 2026-08-16 | 1 | C12-35 L5 cert: the shared moon decoded-source cache coalesces same-realm WebGL+WebGPU viewers; toggles + A/B supersession without churn. |
| probe-morph-midframe.mjs | probe | ACTIVE | 2026-08-16 | 6 | Captures mid-morph frames of timed 3D-to-2D/CV transitions: the WebGPU globe must not vanish mid-morph (mesh.center double-count P1). |
| probe-morph-normals.mjs | probe | ACTIVE | 2026-08-16 | 3 | DP-H35 acceptance: morph-target NORMAL deltas re-shade on WebGPU — within-backend luminance ratio isolates the normal morph from BRDF gaps. |
| probe-motion-blur.mjs | probe | ACTIVE | 2026-08-16 | 4 | WebGPU-only velocity motion blur: deterministic previous-pose control proves smear exists and scales with camera velocity; OFF stability gate. |
| probe-mrt-validation.mjs | probe | INVESTIGATION | 2026-08-16 | 6 | Postmortem instrument: hooks uncapturederror/device.lost per ao-x-deferred cell to name the validation error behind the MRT-flip black canvas. |
| probe-ms-lut-azimuth.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off readback: multiple-scattering + sky-view LUT variation across the view-sun azimuth axis, confirming the all-azimuth re-param took. |
| probe-msaa-comparison.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off: compares MSAA settings + render-bundle state at the globe disk edge via a shimmed Sandcastle Hello World page. |
| probe-msaa-resolve-elision.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance: demand-driven scene-color MSAA resolve — kill-switch A/B counts resolve passes (eager: per segment; elided: exactly 1). |
| probe-multideck-flagon.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | B443 evidence capture: same view with cloud multiDeck OFF (single shell) vs ON (LOW/MID/HIGH decks) for eyeball ordering review; no gate. |
| probe-multideck-parity.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | B443 landing tool: byte-identity of the default (multiDeck OFF) cloud render between PARITY_TAG=main and =modified builds. |
| probe-multideck-views.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | B443 evidence capture: deck stacking/ordering from above all decks (15 km) and between decks (3.5 km), ON vs OFF; eyeball only. |
| probe-mvt-datasource-parity.mjs | probe | ACTIVE | 2026-08-16 | 3 | MVT pipeline parity gate: a synthesized vector tile decodes/builds/renders on both backends — noise-floor pixel diff, 0 errors. |
| probe-mvt-worker-decode.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance for the opt-in decodeInWorker MVT path: a dedicated worker is actually created and the tile still renders at cross-backend parity. |
| probe-new-sandcastles.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Smoke test of the three Batch-91 WebGPU demos in the legacy Sandcastle gallery: load, finishedLoading, screenshot, console errors. |
| probe-normalmap-gbuffer.mjs | probe | ACTIVE | 2026-08-16 | 5 | B135 verification: G-buffer slot 1 emits the perturbed normal so contact shadows track bumps; A/B diff vs geometric-normal baseline. |
| probe-normalmap-ub-diag.mjs | probe | ACTIVE | 2026-08-16 | 2 | B138 diagnostic: inspects NormalMap material uniforms + UB gpuData to explain a 16-byte JS allocation vs the 32-byte WGSL expectation. |
| probe-northpole-angles.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Multi-view north-pole captures on both backends for side-by-side eyeball review during the polar investigation; pinned clock, no gate. |
| probe-npr-outlines.mjs | probe | ACTIVE | 2026-08-16 | 4 | B123 verification: scene.enableNPROutlines A/B diff over canyon terrain — edges on geometry, sky sentinel pixels unchanged. |
| probe-ocean-datum.mjs | probe | ACTIVE | 2026-08-16 | 12 | W0 datum survey gating vertical ocean/tide design: sampleTerrain at 6 open-ocean sites vs EGM2008 + FFT-patch-vs-waterline lanes. |
| probe-ocean-tide-datum.mjs | probe | ACTIVE | 2026-08-16 | 7 | Acceptance for the FFT-ocean datum anchor + equilibrium tide: in-run before/after datum fix, M2-period phase ladder, spring/neap envelope. |
| probe-ocean-wave-lod.mjs | probe | ACTIVE | 2026-08-16 | 5 | C11-172 acceptance: physical-wavelength wave LOD — banded HF-variance gates prove structure near, calm far, animated; renderer hard-checked. |
| probe-ocean-waves-perf.mjs | probe | ACTIVE | 2026-08-16 | 3 | C11-158 perf audit: enhanced-ocean fragment cost ON vs OFF (CPU wall + GPU timestamp per-pass) on a static nadir ocean view; hard watchdog. |
| probe-oit-collection-reachable.mjs | probe | ACTIVE | 2026-08-16 | 5 | C11-157 Slice B: MRT-OIT accumulation reachable for translucent billboard/point/polyline collections under the runtime-flipped FAR-003 gate. |
| probe-oit-model-reachable.mjs | probe | ACTIVE | 2026-08-16 | 4 | C11-157 Slice C: MRT-OIT reachable for translucent models — BLEND primary + per-feature-styled translucent twin; FAR-003 runtime flip. |
| probe-oit-primitive-reachable.mjs | probe | ACTIVE | 2026-08-16 | 3 | C11-157 Slice A: MRT-OIT reachable for translucent primitives via both injectOITOutput branches; FAR-003 runtime flip, hard gates. |
| probe-oit-transparency.mjs | probe | ACTIVE | 2026-08-16 | 9 | OIT coverage + default-flip evidence: WebGL OIT genuinely active; WebGPU opt-in hard-gated active post-Slice-A; splat deferral lane. |
| probe-orbital-1m.mjs | probe | ACTIVE | 2026-08-16 | 6 | Validates the GPU-resident compute-instance pipeline at a 1M-object catalog against negotiated device limits (SSBO sizes, dispatch headroom). |
| probe-orbital-catalog.mjs | probe | ACTIVE | 2026-08-16 | 7 | Regression gate: orbital demo on generic ComputeInstanceCollection renders ~2000 moving points, pinned clock, zero GPU errors |
| probe-orbital-j2.mjs | probe | ACTIVE | 2026-08-16 | 7 | Verifies df64 GPU secular-J2 orbital kernel matches a JS FP64 reference over 30-day propagation and beats the f32 control |
| probe-orbital-sgp4.mjs | probe | ACTIVE | 2026-08-16 | 7 | Verifies GPU df64 near-earth SGP4 kernel against embedded python-sgp4 vectors (<2 km/day); deep-space TLEs must be flagged and skipped |
| probe-overlay-compositing.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Captures 2-layer imagery compositing (Ion + debug tile overlay) on both backends for eyeball check of label orientation and grid alignment |
| probe-panorama-cull-override.mjs | probe | ACTIVE | 2026-08-16 | 4 | Regression probe: panorama's cull.enabled:false override must reach the WebGPU pipeline so the sphere interior renders (was blank) |
| probe-panorama-hdr.mjs | probe | ACTIVE | 2026-08-16 | 1 | Acceptance: WebGPU SkyBox cube-map applies sRGB->linear decode under HDR (matching WebGL) while staying byte-identical on the SDR path |
| probe-particle-no-fog.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | One-off variant of the particle sample: WebGPU-forced Particle System Sandcastle with fog disabled, isolating fog's effect on particles |
| probe-particle-sample.mjs | probe | ACTIVE | 2026-08-16 | 2 | Runs the Particle System Sandcastle demo per backend (Viewer-override shim) and samples the canvas to check particles render on WebGPU |
| probe-pass-counts.mjs | probe | ACTIVE | 2026-08-16 | 3 | Diagnostic: dumps per-pass command counts from frustumCommandsList on WebGPU (which Cesium passes have commands, which are empty) |
| probe-perf-baseline.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Campaign-8 perf baseline: load-time + steady-state idle FPS, WebGL vs WebGPU, on the default globe |
| probe-perinstance-diffuse.mjs | probe | ACTIVE | 2026-08-16 | 3 | Parity gate: lit PerInstanceColorAppearance luminance on WebGPU within 8% of WebGL (fixed light, top-down, shadows/fog off) |
| probe-phase12-bugbash.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gate for four B304 fixes: imagery-projection single-source, uploadImageSource observability, raySphere precision, billboard updateMode order |
| probe-phong-render.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Bring-up diagnostic: does a lit Phong box render at all on WebGPU (brightness + device errors + scene-FB MRT state dump) |
| probe-pick-basic.mjs | probe | ACTIVE | 2026-08-16 | 8 | Minimal pick discriminator: scene.pickAsync must return a Box primitive on the chosen backend; logs pick diagnostics + validation errors |
| probe-pick-metadata.mjs | probe | ACTIVE | 2026-08-16 | 9 | Gate: pickVoxel/pickMetadata center-pixel readback reads the just-rendered pass on WebGPU (fresh 1x1 readback, in-flight guard), not stale |
| probe-pick-multifrustum.mjs | probe | ACTIVE | 2026-08-16 | 6 | Regression gate: two boxes in different frustum slices on the center ray — near object wins the pick; hiding it yields the far one (TAA on) |
| probe-pick-ray-async.mjs | probe | ACTIVE | 2026-08-16 | 7 | Gate: sampleHeight/clampToHeight converge to WebGL-matching heights on WebGPU via scene-depth reuse; pickFromRay warns, never throws |
| probe-pickmodel-instanced.mjs | probe | ACTIVE | 2026-08-16 | 11 | Gate for upstream #13433 port: octDecode arg order + CPU pickModel on instanced models (WebGL readback and WebGPU keepTypedArray paths) |
| probe-pickposition-model-webgpu.mjs | probe | ACTIVE | 2026-08-16 | 9 | Gate: pickPosition over an opaque glTF model returns the model top (not the globe below) on WebGPU — depth re-packed after the OPAQUE pass |
| probe-pickposition-webgpu.mjs | probe | ACTIVE | 2026-08-16 | 16 | Gate: pickPosition returns a real globe-surface Cartesian3 on WebGPU (converges by frame 3) matching WebGL; zoom-to-cursor smoke |
| probe-pipeline-key-aliasing.mjs | probe | ACTIVE | 2026-08-16 | 10 | Runtime detector for pipeline-cache key aliasing: wraps getPipeline, recomputes keys, flags served entries whose shader modules differ |
| probe-plain-hdr-gamma.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance: plain highDynamicRange=true brightness parity WebGL vs WebGPU (sRGB decodes, no double tonemap), with SDR control legs |
| probe-plain-hdr-tonemap.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance for plain-HDR tails: exposure synced to WebGPU tonemap, non-default operators match czm_* references, entity color parity |
| probe-png-bytes.mjs | probe | ACTIVE | 2026-08-16 | 1 | CLI utility: minimal Node PNG decoder reporting mean RGB bytes of output PNGs — 'image is dark' vs 'display looks dark' |
| probe-point-label-partial-write.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gate: settled point+label scene uploads nothing; one moved point = exactly one 112-byte partial write; label text change = full rebuild |
| probe-point-pick-webgpu.mjs | probe | ACTIVE | 2026-08-16 | 7 | Gate: scene.pick/pickAsync over a PointPrimitive returns it with id on WebGPU (warmed sync + async control), at parity with a billboard |
| probe-point-sprite-shape.mjs | probe | ACTIVE | 2026-08-16 | 7 | Parity gate: point-sprite shape (squares vs carved circles) across point-cloud and PointPrimitive scenes; gain-normalized ds4 metric |
| probe-pointcloud-edl-parity.mjs | probe | ACTIVE | 2026-08-16 | 5 | Parity gate: point-cloud Eye-Dome Lighting — WebGPU EDL matches WebGL, on visibly differs from off, and the off path is inert |
| probe-pointcloud-gpulod-scene-wiring.mjs | probe | ACTIVE | 2026-08-16 | 3 | Verifies PointCloudShading.gpuLOD reaches the WebGPU LOD processor, decoupled-scan compute dispatches end-to-end, off-gate keeps atomic path |
| probe-pointcloud-lod.mjs | probe | ACTIVE | 2026-08-16 | 6 | Verifies the LOD compaction WGSL no longer clobbers shared slot 255 at full workgroup occupancy (output = exact permutation 0..255) |
| probe-pointcloud-logdepth.mjs | probe | ACTIVE | 2026-08-16 | 3 | Gate: standalone WebGPU point-cloud renderer writes log frag_depth so it occludes/sorts against the globe identically to WebGL |
| probe-polar-alpha-debug.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Polar black-hole diagnostic: samples post-composite alpha at south-pole-close to test whether imagery was masked out by texCoordsAlpha |
| probe-polar-bisect.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Polar-stretch diagnostic: steps through globeFragmentDebug FS modes at 14 Mm orbit, one screenshot per mode, to locate the streaking stage |
| probe-polar-diff-all.mjs | probe | ACTIVE | 2026-08-16 | 2 | Diff companion: pixel-diffs every polar-multi capture pair in a Playwright page (no Node PNG dep), reporting per-view mismatch and brightness |
| probe-polar-fixed-time.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: captured polar views with the clock frozen to isolate time-of-day drift as the residual-diff source |
| probe-polar-forcered.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: force-red globe FS at south-pole-close to distinguish 'tiles not rasterizing' from 'rasterizing with wrong imagery' |
| probe-polar-fs-stages.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: walks every globe FS debug stage at south-pole-close to find the exact stage where imagery composite drops to black |
| probe-polar-imagery-state.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Diagnostic: dumps per-tile imagery state machine (skeletons, readyImagery, textures) for polar tiles on both backends re layerCount=0 |
| probe-polar-mesh-compare.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Diagnostic: byte-compares polar tile mesh + RTE camera encoding between backends to localize drift to mesh vs downstream RTE/MVP math |
| probe-polar-multi-angle.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: multi-view polar capture WITH the debug tile overlay — diagnosed mirrored tile labels and missing polar imagery |
| probe-polar-multi-plain.mjs | probe | ACTIVE | 2026-08-16 | 6 | Standing polar/global imagery parity capture: 6 views x 2 altitudes, clock pinned to a documented UTC so historical baselines stay comparable |
| probe-polar-noculling.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Diagnostic: tested whether disabling backface culling fixes the polar black hole |
| probe-polar-pixel-sweep.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: samples the center pixel at south-pole-close for each FS debug mode to confirm the WGSL return value at the polar zenith |
| probe-polar-settle.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: captured the polar-stretch artifact at 120/600/2400-frame settle budgets to test settle-dependence vs steady-state |
| probe-polar-stretch-diag.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: reproduced the polar-stretch artifact at WGS84 orbit with the tile-annotation overlay to see which tiles were affected |
| probe-polar-wireframe.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: rendered polar tiles as wireframe to split UV/sampling bugs (mesh present, imagery black) from mesh-construction/culling bugs |
| probe-polyline-appearance-2d.mjs | probe | ACTIVE | 2026-08-16 | 5 | Gate: polyline appearance primitives render in 3D/Columbus/2D/mid-morph on WebGPU via projected-2D plumbing + csm_computePolylinePosition |
| probe-polyline-appearance-logdepth.mjs | probe | ACTIVE | 2026-08-16 | 5 | Gate: appearance/material polylines write log frag_depth matching the globe so surface polylines rest on it at far cameras (no z-fight) |
| probe-polyline-appearance-pick.mjs | probe | ACTIVE | 2026-08-16 | 9 | Gate: scene.pick over a PolylineColorAppearance Primitive returns the primitive on WebGPU (pick pipeline + per-primitive pick command) |
| probe-polyline-appearance-primitive.mjs | probe | ACTIVE | 2026-08-16 | 4 | Gate: Primitive+PolylineColorAppearance renders a screen-space ribbon on WebGPU (dedicated packer/shader; was 0px from collapsed quads) |
| probe-polyline-cloud-consume.mjs | probe | ACTIVE | 2026-08-16 | 6 | Gate: static Polyline/CloudCollections stop re-touching primitives per frame (dirty-consume); tripwire for the cloud scene-FB MSAA mismatch |
| probe-polyline-geodesic.mjs | probe | INVESTIGATION | 2026-08-16 | 5 | Premise-refutation record: proved DP-H7's geodesic-subdivision root cause FALSE — PolylineCollection curves correctly on WebGPU (CPU-side) |
| probe-polyline-image-material.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance: Image-material polyline samples its texture along the line on WebGPU (red->blue gradient split), not a solid color |
| probe-polyline-material-primitive.mjs | probe | ACTIVE | 2026-08-16 | 3 | Gate: Primitive+PolylineMaterialAppearance MATERIAL slice — Dash renders dashed (run-count metric) and Glow renders, at parity with WebGL |
| probe-polyline-multimaterial.mjs | probe | ACTIVE | 2026-08-16 | 6 | Parity gate: one PolylineCollection mixing Solid/Dash/Glow — per-hue run counting proves non-Color groups don't collapse to solid on WebGPU |
| probe-post-process.mjs | probe | ACTIVE | 2026-08-16 | 2 | Diagnostic: dumps enabled-state of upstream postProcessStages vs WebGPU PP pipeline stages on a WebGPU-forced Hello World |
| probe-postprocess-f16.mjs | probe | ACTIVE | 2026-08-16 | 5 | Gate: f16 post-process variants — ON compiles f16 modules per effect with f32-close output; OFF compiles zero f16 modules (off-gate) |
| probe-pp-effects-audit.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | One-off audit: after the B95 AO silent-no-op fix, matrix-diffed bloom/DoF/godRay to surface any effect still silently no-opping |
| probe-pp-frustum-thread.mjs | probe | ACTIVE | 2026-08-16 | 3 | Gate: live frustum near/far + log-depth flag threaded into AO/DoF/GodRay UBs (not the 0.1/10000 placeholder), byte-identical off-gate |
| probe-pp-library-builtins.mjs | probe | ACTIVE | 2026-08-16 | 8 | Gate: the 7 PostProcessStageLibrary builtins get WGSL twins with per-stage cross-backend tolerance, off-gate, and post-tonemap HDR order |
| probe-pp-library-demo.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance for the webgpu-post-process-library demo: asset serves, 7 builtins visibly cycle (stale-pipeline check), None byte-identical |
| probe-pp-silhouette-array.mjs | probe | ACTIVE | 2026-08-16 | 3 | Gate: array form of createSilhouetteStage carries the inner edge stage's custom color/length to the WebGPU twin; single form unchanged |
| probe-precip-data.mjs | probe | ACTIVE | 2026-08-16 | 2 | Gate: data-driven precip — WMO ww maps to type/intensity, visibility couples density, snow-cover ramps, default-OFF leaves manual path intact |
| probe-precip-wiring.mjs | probe | ACTIVE | 2026-08-16 | 5 | Visual gate: weather particles render via the conditions->effects hierarchy (auto and direct facade), rain vs snow differ, off = baseline |
| probe-projection-fix.mjs | probe | ACTIVE | 2026-08-16 | 4 | Verify capture for the useWebMercatorT/textureTranslationAndScale reprojection fix: 7 orbit-altitude views, WebGL vs WebGPU |
| probe-replay-cesium-cmd.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Bring-up diagnostic: replayed the SkyAtmosphere draw command in a controlled pass to split frame-loop faults from bad pipeline/buffers |
| probe-reproj-log.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | One-off diagnostic: captures all console output during a WebGPU load to check whether the reprojection mipmap path is hit |
| probe-reproject-baseline.mjs | probe | ACTIVE | 2026-08-16 | 2 | Golden-PNG guard: pins the forked WebGL per-fragment Mercator->Geographic reprojection output to a stored baseline (--update, tolerance) |
| probe-reprojected-texture-compare.mjs | probe | ACTIVE | 2026-08-16 | 3 | Diagnostic: dumps and pixel-compares the reprojected geographic texture for the same polar tile on both backends to localize algorithm diffs |
| probe-request-render-asymmetry.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Hypothesis probe: does WebGPU's pendingForegroundCount fail to drain under requestRenderMode (fake FPS deficit); plus honest rrm=false lane |
| probe-resident-instance-prev-mirror.mjs | probe | ACTIVE | 2026-08-16 | 3 | Contract gate: WebGPUResidentInstanceBuffer.sync() prev-mirror semantics (rebuild copy, slot-aligned old-value write, flush, settled zero) |
| probe-river-water-intensity.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance/regression: inland river/lake water luminance on WebGPU within ~10% of WebGL via a water-selective blue-pixel metric, day view |
| probe-sampled-position-kernel.mjs | probe | ACTIVE | 2026-08-16 | 5 | Gate: SampledPositionKernel interpolates GPU-resident keyframed positions on BOTH backends, matching pure-JS and SampledPositionProperty refs |
| probe-sampleheight-webgpu.mjs | probe | ACTIVE | 2026-08-16 | 7 | Asserts sampleHeight/clampToHeight work on WebGPU via main-scene-depth reuse (cold-cache converges) with WebGL behavior unchanged. |
| probe-sandcastle-bulk-legacy.mjs | probe | ACTIVE | 2026-08-16 | 2 | Gates DataSourceDisplay bulk vs legacy visualizer callbacks: lane classification correct and bulk << legacy per-frame cost, on the real build. |
| probe-sandcastle-scene-capture.mjs | probe | ACTIVE | 2026-08-16 | 1 | Replays the Scene Capture Reflections demo body against CesiumViewer; capture records publish when ON, zero when OFF, 0 errors. |
| probe-sandcastle2-ports.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | One-off diagnosis loading the same Sandcastle2 demo on the outer :8080 app origin vs inner :8081 bucket origin and comparing. |
| probe-sandcastle2-webgpu-start.mjs | probe | ACTIVE | 2026-08-16 | 1 | Acceptance for the Sandcastle2 frozen-module crash: Mars demo loads on both renderers, no 'Cannot assign to property Viewer', canvas renders. |
| probe-saved-view.mjs | probe | ACTIVE | 2026-08-16 | 16 | Loads user-reported saved-view URLs and captures WebGL vs WebGPU side-by-side; the canonical capture+diff template for view-specific bugs. |
| probe-scene-capture-cardinal.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Ground-truth cardinal check for globe env capture: per-face on-screen camera replicas vs captured cube faces, detecting E/W swap or mirror. |
| probe-scene-capture-off.mjs | probe | ACTIVE | 2026-08-16 | 4 | OFF-parity gate for env scene capture: both default-false flags mean no capture sources, no extra GPU pass, canvas unchanged vs WebGL baseline. |
| probe-scene-capture-on.mjs | probe | ACTIVE | 2026-08-16 | 4 | ON-correctness gate: scene capture renders the globe into the env cube's 6 faces with correct face basis (nadir=terrain, zenith=sky). |
| probe-scene-lights.mjs | probe | ACTIVE | 2026-08-16 | 2 | Verifies the Scene.lights -> frameState.lights -> 164-float packed UBO chain matches the WGSL LightUniforms punctualLights region. |
| probe-scene-snap.mjs | probe | ACTIVE | 2026-08-16 | 3 | C11-212 Scene.snap acceptance: hit within 50 m, sky-corner miss, WebGPU lazy-identity latch, zero errors; exit 3 STRUCTURAL on preconditions. |
| probe-sceneframebuffer.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Black-canvas-era diagnostic: reads the WebGPU scene FBO color texture via copyTextureToBuffer to localize blit vs upstream failure. |
| probe-scheduler-octree-demand.mjs | probe | ACTIVE | 2026-08-16 | 7 | C9-08 gate: scheduler/octree do zero per-command work at defaults; consumer registration pixel-identical; octree never admits terrain/tiles. |
| probe-shim-debug.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Debugs the renderer-override shim used by the cross-backend sandcastle runner (why __capturedViewer stayed null) with an in-page shim log. |
| probe-shim-trace.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Extracts RENDERER_OVERRIDE_SHIM out of cross-backend-sandcastle-runner.mjs by regex and traces its capture state on a legacy gallery demo. |
| probe-skirts-test.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | A/B capture of WebGPU terrain skirts ON vs OFF to test whether blue tile-boundary lines were caused by skirts. |
| probe-sky-atmosphere-coeffs.mjs | probe | ACTIVE | 2026-08-16 | 2 | Regression guard for verified parity: SkyAtmosphere instance coeffs move both backends' sky identically; scene.atmosphere.* moves neither. |
| probe-sky-aureole-anchor.mjs | probe | ACTIVE | 2026-08-16 | 9 | C12-31 aureole certification: whether the sky's bright lobe anchors to the SUN or the VIEW (L1-L4: azimuth, displacement, sunset rejection). |
| probe-sky-ms-azimuth.mjs | probe | ACTIVE | 2026-08-16 | 3 | Verifies the reparameterized MS LUT lifts the twilight sky at ALL azimuths (toward/side/anti sun), directionally, with no wrap seam. |
| probe-sky-ms-directional.mjs | probe | ACTIVE | 2026-08-16 | 3 | Render-level directionality check: MS ON must lift the sun-side half of a horizon-perpendicular view more than the anti-sun half. |
| probe-sky-ms.mjs | probe | ACTIVE | 2026-08-16 | 3 | SKY-MS gate: multipleScattering default-OFF byte-identical across rebuilds; ON measurably brightens the horizon band with sane zenith hue. |
| probe-sky-twilight-range.mjs | probe | ACTIVE | 2026-08-16 | 9 | C12-34 browser acceptance for the twilight sky-brightness curve: shipped-module ENGINE leg plus positional star-contribution PIXELS leg. |
| probe-sky-view-lut.mjs | probe | ACTIVE | 2026-08-16 | 6 | Sun-relative sky-view LUT gate: useScatteringLut default-OFF byte-identical; ON shows correct azimuthal sky variation vs the inline march. |
| probe-skybox-star-modulation.mjs | probe | ACTIVE | 2026-08-16 | 10 | C11-176 star-modulation parity + opt-in: backends modulate identically; in-column 30 km lane proves the flag moves pixels; exit 3 if unseen. |
| probe-skybox-stars-sun-facing.mjs | probe | ACTIVE | 2026-08-16 | 2 | BUG-1 companion: points a deep-space camera at the sun on both backends and reports brightest-cluster location + intensity. |
| probe-skybox-stars-sun.mjs | probe | ACTIVE | 2026-08-16 | 4 | Pinned-clock Earth-limb view: stars, sun, and atmosphere limb render on WebGPU and pixel-match WebGL. |
| probe-slice4-verify.mjs | probe | ACTIVE | 2026-08-16 | 3 | Deterministic 4-cell AO x deferredLighting matrix proving the G-buffer normal source actually feeds AO (Slice 4 engaged, not just AO on). |
| probe-snap-multifrustum.mjs | probe | ACTIVE | 2026-08-16 | 5 | C11-212 multi-frustum snap occlusion: far snappable model hidden/revealed by a near primitive across slices; no stale far-slice payload. |
| probe-source-mercator-compare.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Compares SOURCE Mercator imagery-texture pixels row-by-row across backends to attribute the polar reprojection diff to upload vs algorithm. |
| probe-southpole-diag.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Dumps per-tile selection/mesh/renderable state at lat -89 to find why WebGPU rendered a black hole around the south pole. |
| probe-splat-globe-occlusion.mjs | probe | ACTIVE | 2026-08-16 | 10 | Gaussian splats compose over the opaque globe and stay hidden behind it; OIT-deferral never-drop seatbelt plus occlusion controls. |
| probe-splat-sort.mjs | probe | ACTIVE | 2026-08-16 | 12 | Splat back-to-front sort consumption + log-depth producer gate; docstring voids pre-2026-08-01 gate-OFF results (pipeline-key aliasing). |
| probe-split-screen.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Launches the split-screen comparison page and samples the WebGPU scene-framebuffer center via GPU readback plus frame stats. |
| probe-ssgi.mjs | probe | ACTIVE | 2026-08-16 | 6 | C6 SSGI acceptance: ssgi renders, GI-only debug output non-black, OFF byte-identical, orbit degrades to no-op, zero device errors. |
| probe-ssr-consumer.mjs | probe | ACTIVE | 2026-08-16 | 4 | Verifies SSR reads the G-buffer regardless of deferredLighting (legacy gate B122 removed): SSR-on legs match with deferred on and off. |
| probe-ssr-tuned.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | ssrMaxDistance parameter sweep over the lake+wall scene to find a distance that engages SSR (diagnosing the B132 near-zero signal). |
| probe-ssr-water.mjs | probe | ACTIVE | 2026-08-16 | 6 | SSR verification scene: lake + wall reflector 4-cell matrix; visible reflection when on, deferredLighting toggle now a no-op. |
| probe-standalone-model-pick.mjs | probe | ACTIVE | 2026-08-16 | 5 | Parity gate: scene.pick over a Model added directly to scene.primitives returns the model on both backends; off-model pick undefined. |
| probe-starfield-webgl-parity.mjs | probe | ACTIVE | 2026-08-16 | 6 | WebGL bright-star catalog fallback gate: WebGL draws catalog stars and the pattern matches WebGPU (positional IoU at pinned time, cubemap off). |
| probe-stars-catalog.mjs | probe | ACTIVE | 2026-08-21 | 23 | UUID-bound write-once WebGPU star-catalog evidence acquisition (checks A-G); the gate lib owns the verdict fold. |
| probe-stars-hdr-autoexposure-parity.mjs | probe | ACTIVE | 2026-08-16 | 6 | Guards the B364 fix: WebGPU honors the opt-in auto-exposure flag so the HDR night sky is not crushed to black versus WebGL. |
| probe-stars-hdr-verify.mjs | probe | ACTIVE | 2026-08-16 | 4 | Verifies the WebGPU baked-SkyBox sRGB-to-linear decode under HDR (faint star dusting visible like WebGL) with an SDR no-op control. |
| probe-sun-glow-profile.mjs | probe | ACTIVE | 2026-08-16 | 9 | Measures the sun billboard's radial luminance profile (solar radii) per backend; discriminates the WebGPU zero-contribution near the limb. |
| probe-sun-glowfactor.mjs | probe | ACTIVE | 2026-08-16 | 5 | Gates scene.sun.glowFactor driving the WebGPU sun bake + quad size, with glowFactor=1.0 byte-identical to the historical hardcoded bake. |
| probe-sun-hdr-radiance.mjs | probe | ACTIVE | 2026-08-16 | 4 | Two-radiance discriminator: is the sun-disc excess multiplicative gain or additive pedestal, from plateau ratios via enableTrueSolarRadiance. |
| probe-sun-lens-glare.mjs | probe | ACTIVE | 2026-08-16 | 5 | Locks in the WebGPU sun lens-flare bake (disc + glow + six bursts) present and its halo extent converging with WebGL's SunTextureFS bake. |
| probe-sun-pixel-check.mjs | probe | INVESTIGATION | 2026-08-16 | 8 | Samples canvas-center pixels with the sun centered (Earth behind) to quantify sun rendering and capture all console/validation messages. |
| probe-sun-shadow-gate.mjs | probe | ACTIVE | 2026-08-16 | 7 | Sun-shadow receive-on-globe acceptance: WebGL reference darkening, WebGPU receive ratio band, faded-vs-unfaded darkness asymmetry. |
| probe-sun-stars-extinction.mjs | probe | ACTIVE | 2026-08-16 | 6 | Sun and catalog stars dim/redden through the atmosphere near the horizon on both backends; byte-identical from orbit or atmosphere hidden. |
| probe-taa-disocclusion.mjs | probe | ACTIVE | 2026-08-16 | 3 | Exercises TAA's third disocclusion check (G-buffer normal divergence) under static and orbiting cameras; new binding builds cleanly. |
| probe-taa-jitter.mjs | probe | ACTIVE | 2026-08-16 | 8 | Asserts the TAA sub-pixel jitter survives the WebGPU per-frustum projection recompute and reaches the GPU (projection[8]/[9] non-zero). |
| probe-taa-model-skinned-velocity.mjs | probe | ACTIVE | 2026-08-16 | 5 | Locks shipped TAA-SLICE-2B: a skinned animated model under a stationary camera emits non-zero per-pixel velocity; OFF-gate companion. |
| probe-taa-morph-prevvp.mjs | probe | ACTIVE | 2026-08-16 | 5 | TAA history invalidation across the 2D/3D morph flip: clean render through the transition; motion-vector valid flag drops during MORPHING. |
| probe-taa-resolve.mjs | probe | ACTIVE | 2026-08-16 | 7 | TAA resolve-consumer gate: effect lazily added on first taaEnabled frame; resolve encodes, settled-stable, no smear on rotation. |
| probe-taa-userwarn.mjs | probe | ACTIVE | 2026-08-16 | 4 | Two-part gate: TAA stays pre-tonemap and temporally stable; GLSL-only user post-process stages emit a permanent deduped warn, not silence. |
| probe-taa-velocity-emission.mjs | probe | ACTIVE | 2026-08-16 | 7 | Billboard/point velocity-emission OFF-ON-OFF: velocity commands attach with dual vertex streams, rg16float texture allocates, then detach. |
| probe-terrain-selection-parity.mjs | probe | ACTIVE | 2026-08-16 | 2 | C9-02 fixed-waypoint parity: shared quadtree selection and portable CPU terrain revisions compared across backends at settled checkpoints. |
| probe-terraindata-getters.mjs | probe | ACTIVE | 2026-08-16 | 3 | Guards the credits/waterMask getters on Cesium3DTilesTerrainData that the B243 JSDoc codemod deleted (water + attribution breakage). |
| probe-tex-format.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Dumps imagery-tile texture format fields (format/pixelFormat/internalFormat, isWebGPU) from rendered tiles in a live WebGPU viewer. |
| probe-tileset-capture-face-zoom.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Full-res readback of all 6 env-cube faces for the tileset capture so buildings and occlusion order are verifiable by eye, ON vs OFF. |
| probe-tileset-capture-reflection.mjs | probe | ACTIVE | 2026-08-16 | 1 | 3D tileset reflection-capture gate: red-styled buildings publish via the model producer into env cube faces; correct occlusion, 0 errors. |
| probe-timedynamic-pointcloud-load.mjs | probe | ACTIVE | 2026-08-16 | 7 | Regression probe for TimeDynamicPointCloud loading zero on WebGPU: animates the 5-frame sample; checks boundingSphere, memory bytes, pixels. |
| probe-tpdf-dither.mjs | probe | ACTIVE | 2026-08-16 | 2 | C6 TPDF dither acceptance: banding metrics on a sky gradient (distinct colors up, max run down); OFF leaves no residue (frame hash equal). |
| probe-trans-scale.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Prints tileImagery.textureTranslationAndScale for rendered tiles on both backends at close zoom. |
| probe-uniformstate-viewport-371.mjs | probe | ACTIVE | 2026-08-16 | 3 | Gate for UniformState.viewport seeding on WebGPU: viewportTransformation non-identity and matches WebGL; polyline-ribbon pixel check. |
| probe-unlit-vertexcolor.mjs | probe | ACTIVE | 2026-08-16 | 4 | Permanent sentinel: a KHR_materials_unlit quad with VEC3 COLOR_0 must never go black on WebGPU nor diverge from WebGL (report proven stale). |
| probe-vec4-error.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Sweeps affected demos for the UniformArrayFloatVec4.set 'Invalid vec4 value' error using the renderer-override shim. |
| probe-vector-draping.mjs | probe | ACTIVE | 2026-08-16 | 8 | C11-213 acceptance for terrain-draped vector polylines: backend/placement/material/Jacobian/cleanup gates with STRUCTURAL verdicts. |
| probe-vector3dtile-vctr.mjs | probe | ACTIVE | 2026-08-16 | 6 | First real .vctr end-to-end pixel parity: polygon/polyline classifiers from upstream fixtures with IoU masks; stencil Z-fail verified. |
| probe-vertex-lighting.mjs | probe | ACTIVE | 2026-08-16 | 3 | Smoke-verifies the globe VERTEX_LIGHTING path with world-terrain vertex normals; lambertDiffuseMultiplier must visibly move the canvas. |
| probe-vertexcolor-vec3.mjs | probe | ACTIVE | 2026-08-16 | 3 | DP-H37 guard: unlit VEC3 COLOR_0 quad renders identical vertex colors across backends (float32x4 stride mis-declare would shift alpha). |
| probe-volcloud-toggle.mjs | probe | ACTIVE | 2026-08-16 | 3 | Smoke-tests that clouds.enableVolumetric activates the volumetric raymarcher and echoes the legacy flags, via a gallery-demo viewer shim. |
| probe-volumetric-clouds.mjs | probe | ACTIVE | 2026-08-16 | 4 | Scout probe: does the WebGPU volumetric cloud raymarcher render cloud pixels at all — bright-pixel count vs WebGL at a cloud-covered view. |
| probe-voxel-cell-pick.mjs | probe | ACTIVE | 2026-08-16 | 14 | Byte-level cross-backend parity of pickVoxelCoordinate decode: single tile, refined L1 octree, customShader alpha gate, refined L3 (Parts A-D). |
| probe-voxel-cylinder.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance: WebGPU voxel march intersects a bounded hollow cylinder (not the box proxy) and cylindrical shapeUv cell colors match WebGL. |
| probe-voxel-ellipsoid.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance: WebGPU voxel march intersects the oblate ellipsoid shell and lon/lat/height shapeUv cell colors match WebGL (IoU + color gates). |
| probe-voxel-megatexture.mjs | probe | ACTIVE | 2026-08-16 | 7 | Acceptance: real tile data reaches the 3D megatexture; demand-driven descendant streaming; LRU eviction over a capacity-capped atlas. |
| probe-voxel-octree-l3plus.mjs | probe | ACTIVE | 2026-08-16 | 5 | Acceptance: WebGPU voxel octree traversal reaches level 3 (585-slot atlas, 4-level fixture) with per-ray in-page discriminators at three views. |
| probe-voxel-octree.mjs | probe | ACTIVE | 2026-08-16 | 7 | Acceptance: voxel octree LOD refinement to level 2 (73-slot atlas) with L1/L2 discriminator families and cone-sampled in-page expectations. |
| probe-voxel-parity.mjs | probe | ACTIVE | 2026-08-21 | 7 | Acceptance: the WebGPU voxel box renders at the correct world placement/extent (footprint IoU + color structure vs WebGL), not a flat quad. |
| probe-voxel-pick-logdepth.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance: voxel pick with the log-depth gate forced ON — same cell picked, [ld] pipelines bound, occlusion proves frag_depth is written. |
| probe-voxel-pick.mjs | probe | ACTIVE | 2026-08-16 | 9 | Acceptance: public Scene.pickVoxel end-to-end on both backends — VoxelCell returned without throw, identical color/tile/sample cross-backend. |
| probe-voxel-refined-pick.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance: Scene.pickVoxel on a refined octree tile — retained child content yields a full VoxelCell with identity-encoded color parity. |
| probe-voxel-user-customshader.mjs | probe | ACTIVE | 2026-08-16 | 6 | Acceptance: user voxel customShader — GLSL (WebGL) vs native-WGSL codegen (WebGPU) render the same blue-red ramp; pipeline-name gate. |
| probe-vr2-polylines-3dtiles.mjs | probe | ACTIVE | 2026-08-16 | 5 | Repro: clampToGround classification polyline on the BIM tileset — quantifies the WebGPU saturated cyan/red shadow-volume panels vs WebGL. |
| probe-vr2-tile-brightness.mjs | probe | ACTIVE | 2026-08-16 | 4 | Repro: per-tile imagery brightness anomaly at 5 Mm over Lake Superior — max adjacent-block luminance jump WebGPU vs WebGL; PROBE_DARK lane. |
| probe-wasm-bundle-load.mjs | probe | ACTIVE | 2026-08-16 | 6 | Proves all 7 Wasm*Bridge kernels load and genuinely execute in the emitted bundle (zero wasm 404s, WASM-vs-JS byte identity); --iife mode. |
| probe-water-mask-coast-aa.mjs | probe | ACTIVE | 2026-08-16 | 4 | Before/after acceptance for the anti-aliased water-mask coastline band on both backends: coast Laplacian energy + changed-pixel locality. |
| probe-weather-channels.mjs | probe | ACTIVE | 2026-08-21 | 16 | Gate-B leg: raymarcher applies weather-map G/B/A channels, 9-longitude sweep with a richA/richB determinism control bracketing scored swaps. |
| probe-weather-edr-mock.mjs | probe | ACTIVE | 2026-08-21 | 7 | Gate-B leg: full EDR ingest chain (fetch, CoverageJSON, packer, weatherTex, clouds) end-to-end against the /mock-edr fixture, offline. |
| probe-weather-ingest.mjs | probe | ACTIVE | 2026-08-21 | 7 | Gate-B leg: ingest MVP — SyntheticWeatherSource through provider/packer to the C2-16 weather map; deck appears at 0.95, clears at 0.0. |
| probe-weather-inspector.mjs | probe | ACTIVE | 2026-08-16 | 4 | Boots the Weather Inspector Sandcastle demo standalone and drives its real DOM controls: coverage slider + OVC preset change the sky. |
| probe-weather-map.mjs | probe | ACTIVE | 2026-08-16 | 7 | Keystone C2-16 seam check: cloudWeatherMap ON makes coverage vary spatially across locations (high cell stddev); OFF stays uniform. |
| probe-weather-metar.mjs | probe | ACTIVE | 2026-08-21 | 9 | Gate-B leg: full-RGBA METAR chain (obs parse, IDW rasterize, packer) against the /mock-metar fixture; spatial + calibrated channel gates. |
| probe-weather-presets.mjs | probe | ACTIVE | 2026-08-16 | 4 | Sweeps the Weather Inspector's 8 METAR/WMO presets: okta brightness ladder holds (clear > broken > overcast/storm), 0 device errors. |
| probe-weather-regional-tails.mjs | probe | ACTIVE | 2026-08-16 | 5 | C13-08: cyclic CoverageJSON crossing +/-180 ingests parser-to-shader on WebGPU; WebGL billboard pixels stay unchanged under the provider. |
| probe-weather-seam-poles.mjs | probe | ACTIVE | 2026-08-21 | 6 | C13-07 pixel gate: no dateline luminance wall (frame-relative column-step test), bounded polar-cap variance, no NaN cluster; non-vacuity gate. |
| probe-weather-time.mjs | probe | ACTIVE | 2026-08-16 | 6 | Weather time-model logic probe (no render): slice quantization, version-on-slice-change, historical/projected resolve, LRU scrub-back hit. |
| probe-weather-wcs.mjs | probe | ACTIVE | 2026-08-21 | 6 | Gate-B leg: OGC API-Coverages ingest via the shared CoverageJSON parser against the /mock-wcs fixture — same pattern gates as the EDR mock. |
| probe-webgpu-allocation-tax.mjs | probe | ACTIVE | 2026-08-16 | 5 | Instruments raw browser WebGPU/WebGL API boundaries to detect a hidden WebGL context in explicit-WebGPU scenes and classify compat allocations. |
| probe-webgpu-frame-breakdown.mjs | probe | ACTIVE | 2026-08-16 | 5 | C11-169 exact CPU frame-accounting gate: per-frame conservation (total = passes + phases + unattributed) over the shared track; negative lanes. |
| probe-webgpu-grey.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Quick diagnostic that opened the split-screen page and captured console errors + debug snapshot chasing the all-grey regression. |
| probe-webgpu-model-shadow-command-graph.mjs | probe | ACTIVE | 2026-08-16 | 1 | C11-184 runtime companion: inspects Model's WebGPU command graph at the PVS boundary — caster layouts, variant isolation, zero idle UB churn. |
| probe-webgpu-ocean-waves.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance for the WebGPU bright/flat ocean bug: ocean brightness and spatial wave variance vs WebGL at a low-oblique daytime coastal view. |
| probe-webgpu-reinit-switch.mjs | probe | ACTIVE | 2026-08-16 | 4 | Acceptance for the re-init lifecycle bug: WebGL-WebGPU-WebGL-WebGPU switches; gates the second WebGPU frame being non-black. |
| probe-webgpu-tile-popping.mjs | probe | ACTIVE | 2026-08-16 | 2 | Acceptance for the stale tile-buffer-cache fix: counts intra-frame black wedges during a cold LOD zoom; WebGPU must not exceed WebGL. |
| probe-wgs84-alphadbg.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off debug: sampled tex.a values after the Batch-56 alpha=1 force in the WebGPU imagery-reprojection fragment shader. |
| probe-wgs84-atmo.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off debug harness from the WGS84 reprojection investigation: WGS84 terrain + window debug-flag toggle, 1200 frames, screenshot capture. |
| probe-wgs84-close-postfix.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | One-off check that close zoom did not regress after Batch 56's per-fragment ground-atmosphere fix on the WGS84 ellipsoid. |
| probe-wgs84-layer1-alpha.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off debug harness from the WGS84 reprojection alpha investigation: terrain + debug-flag toggle capture (layer-1 alpha variant). |
| probe-wgs84-polar-stretch.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Repro of the user-reported northern-latitude polar stretching on WGS84 orbit at the default home view, WebGL vs WebGPU. |
| probe-wgs84-postcomposite.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off debug harness from the WGS84 reprojection investigation: terrain + debug-flag toggle capture (post-composite stage variant). |
| probe-wgs84-quick.mjs | probe | INVESTIGATION | 2026-08-16 | 4 | Quick orbit-only WebGL-vs-WebGPU comparison used to verify the Batch-56 alpha=1 force in WebGPUImageryReprojection. |
| probe-wgs84-sample0.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | One-off sample0 texture debug after the Batch-56 alpha=1 reprojection fix on the WGS84 ellipsoid. |
| probe-wgs84-varyings.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | One-off debug harness from the WGS84 reprojection investigation: terrain + debug-flag toggle capture (shader varyings variant). |
| probe-wgs84.mjs | probe | ACTIVE | 2026-08-16 | 4 | Family-root repro: WGS84 EllipsoidTerrainProvider (unquantized, no webMercatorT) + imagery combos — the black-wedges symptom on WebGPU. |
| probe-wgsl-compile-error.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Diagnostic: hooks createShaderModule and dumps WGSL compile errors with source context for Model PBR variants (built for 0x8200 regression). |
| probe-wgsl-doctype.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | Diagnostic: loads named Sandcastle demos under a renderer-override shim to reproduce the WGSL-parser DOCTYPE error (shader fetch got HTML). |
| probe-wireframe-verify.mjs | probe | ACTIVE | 2026-08-16 | 3 | Acceptance for the WebGPU debugShowWireframe fix: wireframe draws an imagery-colored line mesh (not black), settled by frame-signature stability. |
| prohibited-reader-allowlist.spec.mjs | spec | ACTIVE | 2026-08-21 | 0 | Enforce the measured prohibited-reader allowlist as a shrink-only ratchet. |
| prohibited-reader-rule.spec.mjs | spec | NO @purpose HEADER | 2026-08-20 | 0 | — |
| purpose-header-contract.spec.mjs | spec | ACTIVE | 2026-08-21 | 8 | Contract spec for maintainer ruling M4: every probe and gate library must carry a readable @purpose/@status header. |
| run-performance-campaign.mjs | runner | ACTIVE | 2026-08-16 | 27 | The performance characterization runner: consumes performance-workloads.json, records Scene.render CPU samples + GPU timestamps; never FPS. |
| run-regression-sweep.mjs | runner | INVESTIGATION | 2026-08-16 | 0 | Batch-146 sequential sweep of the Batches 134-145 probe arc, parsing stdout tails for PASS/FAIL markers — a did-the-arc-break-anything check. |
| sandcastle-batch-66-end-of-session-runner.mjs | other | INVESTIGATION | 2026-08-16 | 2 | End-of-session rerun of the Batch-66 Sandcastle sweep (direct scene.pick, pointer-error filtering) writing per-demo screenshots + report. |
| sandcastle-batch-66-final-runner.mjs | other | INVESTIGATION | 2026-08-16 | 10 | Post-F1/F2/F3 rerun of the Batch-66 WebGPU Sandcastle sweep: every 'WebGPU *.html' demo headless, known artifacts filtered, JSON report. |
| sandcastle-smoke.mjs | other | ACTIVE | 2026-08-16 | 6 | Standing Sandcastle CI blind-spot smoke: three local-resource WebGPU gallery demos gated on non-black, non-uniform, real device, zero errors. |
| settle-attribution.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Guard spec for the settle-window attribution rule + first-complete-frame metric, so GPU-submit-bound windows never book main-thread credit. |
| sgp4-cpu-kernel.mjs | other | ACTIVE | 2026-08-16 | 5 | Demo/probe-owned CPU FP64 near-earth SGP4 kernel mirroring the WGSL kernel, shaped as a ComputeInstanceCollection cpuKernel (42-lane layout). |
| sgp4-kernel.mjs | other | ACTIVE | 2026-08-16 | 4 | Demo/probe-owned SGP4 GPU artifacts: param-lane packer with df64 secular rates + the WGSL df64 time-update kernel string. |
| sgp4-reference.mjs | other | ACTIVE | 2026-08-16 | 7 | Self-contained JS FP64 near-earth SGP4 (Vallado, WGS-72): sgp4init pre-conditioning + sgp4 time update; the ground truth the GPU kernel ports. |
| sky-band-compare.mjs | other | NO @purpose HEADER | 2026-08-01 | 1 | — |
| sky-brightness-twilight.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | C12-34 acceptance: the SkyBrightness log-luminance estimator separates the twilight bands the old smoothstep collapsed; mutation-tested. |
| sky-light-direction.spec.mjs | spec | ACTIVE | 2026-08-21 | 6 | C12-31 contract: atmosphere NONE mode uses the astronomical Sun (not per-sample local-up), LEGACY_OVERHEAD reproduces history, twin lockstep. |
| skybox-diffuse-seam.spec.mjs | spec | ACTIVE | 2026-08-16 | 12 | Standing DR-01 proof: diffuse skybox faces stay low-passed (no resolved points), band structure + TYCHO_T5 reversal intact, hashes re-derived. |
| skybox-resolution-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Browser-free trust anchor for the star cube-map policy: 2048 default vs disk both directions, honest 4096 opt-in fallback, VRAM re-derived. |
| solar-disc-model.spec.mjs | spec | ACTIVE | 2026-08-16 | 7 | Pins SolarDiscModel as the one constants source for eclipse photometry + both sun-disc bakes: limb law, glare profile, byte-exact OFF toggles. |
| solar-glare-star-washout.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | C12-27: extracts solarGlareVeil from five shader texts, compiles each, requires 1e-15 agreement with the JS reference; rejects 7 wrong curves. |
| spec-cesium-viewer-dev-ui.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | CesiumViewer start contract: dev chrome built only under devUi (absent, not hidden), bare URL resolves WebGPU non-strict, fleet URLs stable. |
| spec-cesium-viewer-loading-parity.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Loading-presentation parity: the async WebGPU viewer path adds no chrome of its own; the page indicator hides at first rendered frame on both. |
| spec-offline-isolation.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | C11-134: pins the external-URL classifier (fail-closed) and the online-lane quarantine so network suites skip with a reason offline. |
| star-catalog-depth.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | C12-09 acceptance for the deepened BrightStarCatalog: count/magnitude bands, MAG_CUTOFF = faintest row, no duplicates, sha256 provenance. |
| star-point-census-live.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Standing discriminator: the star point census was mis-calibrated for live frames (strict local-max tie at the NDC-origin pixel corner). |
| starfield-psf.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | C12-05..08 analytic acceptance: CPU reference of the Moffat core+wing PSF and linear-Pogson mapping; WGSL/GLSL constant lockstep. |
| stbn-asset.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Pins the bundled STBN blue-noise atlas: byte/manifest SHA-256, re-measured spectra, histogram uniformity, provenance, with mutant controls. |
| sun-halo-composition.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Node gate: WebGPU sun blends ALPHA_BLEND, disc edge at 1.0 Rsun, exactly one live halo source, GLSL/WGSL veil equivalence to 1e-15. |
| sun-hdr-radiance.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Node gate for true-HDR sun radiance: derived disc radiance, alpha-clamp safety, derived BrightPass retune, SunPostProcess 8-bit vacuity fix. |
| sun-orbital-limb-extinction.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Measures that Sun.js's extinction integrator already yields the orbital-sunset reddening ramp; 16-sample rule vs 40k-sample oracle. |
| sun-radiance-delta.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Browser-free guard for the two-radiance solar-disc probe lane: pre-registration vs SolarDiscModel, measurement recovery, named mutant worlds. |
| texture-mip-queue-safety.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Gate for the texture-mip generation queue on WebGPUContext: job stamping, dedupe, transactional requeue, cube-layer slicing, teardown order. |
| tidal-harmonics.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | Executable tide gates: Doodson arguments vs published elements, UT1/TT bridge, spring/neap on syzygy, sub-lunar bulge, atlas round-trip. |
| tileset-lifecycle-v2.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | node:test coverage of the representative-tileset lifecycle tracker using fake tiles, requests and content promises. |
| tileset-request-ledger.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | node:test coverage of the tileset request ledger: sequenced issue/cancel/reissue diagnostics, ledger creation and cross-run comparison. |
| tooling-coverage.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Coverage-of-the-checkers gate: writes broken fixtures under Tools/ and asserts the real prettier/eslint configs actually reject .mjs files. |
| track-entity-probe.mjs | other | ACTIVE | 2026-08-16 | 3 | Playwright diagnostic for viewer.trackedEntity on WebGL vs WebGPU via the Sandcastle renderer shim; reports camera/model state over time. |
| translucent-classification-debug.mjs | other | INVESTIGATION | 2026-08-16 | 2 | Console-capture harness for the WebGPU Translucent Classification demo; groups GPU validation errors around the GlobePass error scope. |
| validate-f16-wgsl.mjs | other | ACTIVE | 2026-08-16 | 1 | Naga-WASM compile gate for every PostProcess *_f16.wgsl variant; exit 1 on rejection. For machines whose GPU lacks shader-f16. |
| validate-sgp4.mjs | other | ACTIVE | 2026-08-16 | 5 | Dev gate proving the JS FP64 SGP4 reference matches python-sgp4 2.25 vectors to <1 m before the GPU kernel is judged against it. |
| vector-layer-draping.spec.mjs | spec | ACTIVE | 2026-08-20 | 8 | Acceptance for WebGPU vector-layer draping: GLSL-derived oracle vs real storage-buffer packer/WGSL indexing, six named mutations. |
| verify-b3dm-render.mjs | other | ACTIVE | 2026-08-16 | 7 | WebGL-vs-WebGPU screenshot smoke that the canonical BatchedWithBatchTable b3dm tileset renders; closed the bind-group consolidation loop. |
| verify-batches-106-109.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Batch-scoped verification of velocity pass, refraction capture, point-light shadows and the HDR-toggle gate; PNG-size + console smoke. |
| verify-classification-fr.mjs | other | ACTIVE | 2026-08-16 | 3 | Smoke that DepthPlane/GroundPolyline/ClassificationPrimitive/Vector3DTile FR families construct, render and stay error-free on WebGPU. |
| verify-glb-renders.mjs | other | INVESTIGATION | 2026-08-16 | 2 | Hypothesis check from the early model-rendering bug: loads CesiumAir.glb on WebGPU and probes whether the model cache populates primitives. |
| verify-glb-side-by-side.mjs | other | INVESTIGATION | 2026-08-16 | 5 | Side-by-side WebGL/WebGPU capture of CesiumAir.glb from the era when WebGPU drew '3 tiny dots'; establishes the reference look. |
| verify-gp-debug-volume.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Differential GP diagnostic: renders with _debugShowShadowVolume to split 'VS emits nothing' from 'classifier discards everything'. |
| verify-gp-no-polyline.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Control leg for the GP investigation: same camera with no polyline, to test whether the 'grey rectangles' were terrain artifacts. |
| verify-ground-polyline-zoom.mjs | other | ACTIVE | 2026-08-16 | 2 | Close-zoom GroundPolylinePrimitive render check on either backend (renderer as argv); screenshots plus GP-DIAG console capture. |
| verify-hdr-taa.mjs | other | ACTIVE | 2026-08-16 | 2 | HDR+TAA interaction matrix: initial-mount both-on, each toggle order, round-trip off; fails on GPU validation errors or empty renders. |
| verify-initial-hdr.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Diagnostic splitting 'HDR completely broken' from 'HDR runtime toggle broken' by mounting the viewer with HDR on before frame one. |
| verify-model-feature-pick.mjs | other | ACTIVE | 2026-08-16 | 13 | End-to-end per-feature pick on WebGPU: loads a batch-table tileset, picks at center, asserts the result carries a featureId not just the Model. |
| verify-pick-webgl-control.mjs | other | ACTIVE | 2026-08-16 | 3 | WebGL control leg for the model-feature pick probe: same tileset/camera/pick on the reference backend to isolate WebGPU-specific defects. |
| verify-vector-3dtile-frs.mjs | other | ACTIVE | 2026-08-16 | 3 | Smoke for Vector3DTilePrimitive/Polylines/ClampedPolylines feature renderers: FR registration, createCommands, error-free render loop. |
| visual-evidence-library.mjs | other | ACTIVE | 2026-08-16 | 2 | CLI for the append-only content-addressed visual-evidence library: archive/import-legacy/verify/catalog/upgrade with provenance and run identity. |
| visual-evidence-library.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | node:test coverage of the evidence-library lib + CLI: schemas, archive/verify/catalog/upgrade flows, provenance, usage errors, tmpdir fixtures. |
| voxel-inside-camera-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Device-free gate for camera-inside voxel proxy rendering: executes real WebGPUVoxelRenderer index helpers via esbuild bundle + structural pins. |
| voxel-megatexture-reupload-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Mutant gate for the voxel megatexture reupload evidence policy: valid resident/eviction/return evidence passes, each corruption must go red. |
| weather-field-bounds.spec.mjs | spec | ACTIVE | 2026-08-16 | 6 | WeatherField contract: grid registration, regional bounds honoured incl. antimeridian, no-data semantics, global path byte-identical to legacy. |
| weather-map-seam.spec.mjs | spec | ACTIVE | 2026-08-16 | 7 | Pins the one equirect weather-map convention shared by CPU producers and, textually, the WGSL/sampler half: seam filters, UV mapping, bounds pack. |
| weather-probe-headroom.spec.mjs | spec | ACTIVE | 2026-08-21 | 6 | Guard Gate-B headroom/determinism repairs plus canonical immutable capture across the shared weather pinning helper and every direct consumer. |
| weather-regional-tails.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Contract for the rendered-tail browser probe: cyclic CoverageJSON parse, fused capture, policy rejecting duplicated antimeridian band. |
| webgl-snap-multifrustum.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Source pins for WebGL Scene.snap occluders in DerivedCommand/Scene/SceneRenderer: depth-only reuse, zero color write, blending off, depthMask. |
| webgl-vs-webgpu-pixel-check.mjs | other | INVESTIGATION | 2026-08-16 | 0 | Test-infra sanity check from the canvas-black-screen investigation: do non-black pixels reach toDataURL on each backend at all? |
| webgpu-cloud-shadow-bind-group-cache.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Drives the real WebGPUCloudShadowBindGroupCache on a fake device: per-slot dedupe, descriptor identity, invalidation on resource change. |
| webgpu-dynamic-environment-recovery.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Source-anchored pins that dynamic environment-map caches are owned by one device generation and recover across manager/capture/Scene wiring. |
| webgpu-frame-accounting-policy.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Guard for the frame-breakdown probe's accounting: phase names match the engine profiler, coverage/overlap validity, request-render suppression. |
| webgpu-pick-center-identity.spec.mjs | spec | ACTIVE | 2026-08-21 | 6 | Fake-device coverage of WebGPUPickFramebuffer/PickPass readback identity: map/unmap lifecycle, per-identity pixel decode, voxel pick pins. |
| webgpu-pick-miniframe-clear-guard.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Pins that standalone WebGPU pick mini-frames reset their own clear-loop budget: beginPickFrame resets counters and creates its encoder. |
| webgpu-shadow-receive-contract.spec.mjs | spec | ACTIVE | 2026-08-21 | 2 | Pins the sun-shadow fix: single cast-dispatch site + same-frame wipe guard, receive matrix reproduces the cast texel, naga-validated shaders. |
| webgpu-snap-edge-payload.spec.mjs | spec | ACTIVE | 2026-08-16 | 5 | Contract for the edge tier of WebGPU Scene.snap: edge-flag payload encode, pick-color plumb into the edge UB, pipeline variant, strict admission. |
| webgpu-snap-framebuffer-lifecycle.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Behavioral lifecycle coverage of the real WebGPUSnapFramebuffer on GPU-shaped mocks; complements the source-contract snap-payload spec. |
| webgpu-snap-payload.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Contract for WebGPU Scene.snap payload: one encoding home (WebGPUSnapPayload.ts), rg32uint format agreement, spiral decode, naga validation. |
| webgpu-sun-bloom-mirror.spec.mjs | spec | ACTIVE | 2026-08-16 | 4 | Guard that both backends draw ONE sun glow: WebGPU tuning derived from SolarDiscModel not copied, shared constants, one flag, WebGL untouched. |
| webgpu-voxel-resource-lifecycle.spec.mjs | spec | ACTIVE | 2026-08-21 | 2 | Drives real WebGPUVoxelResourceLifecycle exports (retain/release, atlas slot publish/retire/LRU, async-failure capture) plus structural pins. |

### Tools/visual-regression/archive/ (16)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| diff-fog-ms.mjs | other | INVESTIGATION | 2026-08-16 | 1 | CLI exact pixel diff of two canvas PNGs via Playwright canvas decode; reports differing-pixel count/%/max channel delta (fog-MS parity gate tool). |
| diff-multideck.mjs | other | INVESTIGATION | 2026-08-16 | 1 | CLI byte-identical (threshold 0) pixel diff for the CLOUD-MULTIDECK parity pair via Playwright canvas decode. |
| probe-cloud-cone-equal.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | B436 equal-quality A/B of straight vs Schneider 6-tap cone light march by flipping the TEMP window.__FORCE_CONE renderer override |
| probe-cloud-cone-perf.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | B436 GPU-synced cost A/B of straight vs cone light march via the TEMP window.__FORCE_CONE override |
| probe-dp46a-metadata.mjs | probe | INVESTIGATION | 2026-08-16 | 3 | DP-H46a de-risk proof: property-attribute metadata reaches the WGSL FS via a debug stub (gradient detector) + MODEL_HAS_METADATA off-parity. |
| probe-globe-tile-trace.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Reads cumulative globe tile-trace debug globals (__dbgGlobeTileTraceGet etc.) plus pipeline-cache size after a settle loop |
| probe-globe-timing.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Collects '[GLOBE-PIPELINE]' console timing logs and __dbgResolveGlobe/__dbgSelectPipeline state during a settle loop |
| probe-gpu-tex.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Early attempt to introspect the globe imagery texture cache from the page; never reaches the per-device renderer instance |
| probe-imagery-format.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Tried to sample imagery texture formats via a ctx._globeImageryCache field on a Sandcastle Hello World boot |
| probe-logdepth-diag.mjs | probe | INVESTIGATION | 2026-08-16 | 1 | Read the classifier dsColorFS 'TEMP DIAG' RGB encoding (storedDepth/eyeDist/encFar) to localize breaks in the log-depth reconstruction chain |
| probe-tonemap.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Shim-forces WebGPU on the legacy Hello World Sandcastle page and inspects post-process pipeline stage state (tonemap/colorGrading/FXAA). |
| probe-trace-counts.mjs | probe | INVESTIGATION | 2026-08-16 | 2 | Reads window.__dbgDrawCounts draw counters described as instrumented into WebGPUSceneRenderer.ts + WebGPUDrawCommand.ts. |
| quick-screenshot.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Minimal utility: captures one WebGPU and one WebGL CesiumViewer screenshot at a fixed view after 240 rendered frames. |
| sandcastle-batch-66-runner.mjs | other | INVESTIGATION | 2026-08-16 | 2 | Batch-66 rerun of the Batch-65 Sandcastle sweep adding the rendering-error hard-FAIL marker and the viewer-capture init shim. |
| split-screen-debug.mjs | other | INVESTIGATION | 2026-08-16 | 1 | Quick diagnostic: opens the split-screen page, clicks Launch, logs all console/page errors while both viewers render. |
| temp-pbr.mjs | other | INVESTIGATION | 2026-08-16 | 3 | One-shot Edge screenshot + cubemap/texture console-error dump of the glTF PBR Extensions demo on WebGPU (KTX2 load check). |

### Tools/visual-regression/fixtures/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| voxel-octree-l3.mjs | fixture | ACTIVE | 2026-08-16 | 6 | Self-contained 3-level CUSTOM box voxel provider whose self-similar gy==gz diagonal yields per-level traversal-depth discriminators for octree probes. |
| voxel-octree-l4.mjs | fixture | ACTIVE | 2026-08-16 | 5 | 4-level small-tile (2x2x2) CUSTOM voxel provider whose L3 discriminators detect whether the WebGPU march reaches octree depth 3. |

### Tools/visual-regression/fixtures/nasa-svs-5073/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| derive-umbra-lo-shard.mjs | fixture | ACTIVE | 2026-08-16 | 2 | Deterministically crops four hash-verified umbra_lo records from NASA SVS 5073 into the pinned C12-29 S5 eclipse-footprint fixture shard. |
| nasa-svs-5073-shapefile.mjs | fixture | ACTIVE | 2026-08-16 | 5 | Dependency-free ESRI Shapefile Polygon + dBASE reader for the SVS 5073 umbra fixture, parseable by node --test and same-origin browser probes alike. |

### Tools/visual-regression/lib/ (83)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| backend-isolation-launch.mjs | lib | ACTIVE | 2026-08-20 | 3 | The gated launch step for lanes whose page builds nothing until a launch control is pressed. |
| build-source-identity.mjs | lib | ACTIVE | 2026-08-16 | 20 | Shared provenance helpers: safe git HEAD, build/shader fingerprinting, and the STRUCTURAL build-absent reason evidence shards bind to. |
| c11-13-public-voxel-pick-convergence.mjs | lib | ACTIVE | 2026-08-16 | 3 | Pure convergence predicate for Scene.pickVoxel warm-up: two consecutive identical real cells establish stability; an absent result resets the streak. |
| c11-13-voxel-inside-camera-probe.mjs | lib | ACTIVE | 2026-08-16 | 3 | Shared implementation of the C11-13 inside-camera voxel probe: watchdogs, waypoint ladder, 18 error lanes, capture plumbing used by probe and spec. |
| c11-13-voxel-pick-pipeline-name.mjs | lib | ACTIVE | 2026-08-16 | 3 | Derives the one exact voxel-pick pipeline name from independent log-depth state; returns null (structural) rather than inferring from the descriptor. |
| c11-146-route-evidence.mjs | lib | ACTIVE | 2026-08-16 | 2 | Fail-closed C11-146 acceptance for the moving-altitude route: missing metrics or unbound runtime bytes cannot inherit a generic campaign PASS. |
| c11-168-direct-model-ablation.mjs | lib | ACTIVE | 2026-08-16 | 4 | Renderer-neutral C11-168 causal discriminator: rejects incomparable run quartets and computes the predeclared difference-in-differences fail-closed. |
| c11-205-evidence.mjs | lib | ACTIVE | 2026-08-16 | 7 | Pure gate classification (true/false/null; exits 0/1/2/3) shared by 3D Tiles lifecycle probes and the performance campaign so verdicts agree. |
| c11-205-owner-attribution.mjs | lib | ACTIVE | 2026-08-16 | 4 | Frozen config plus fail-closed policy for the resident-SF CPU owner-attribution diagnostic; instrumented timings never recertify the causal artifact. |
| c11-209-effects-placeholder-provenance.mjs | lib | ACTIVE | 2026-08-16 | 2 | Provenance fingerprints binding the effects-depth-placeholder startup token across engine source, bundle, source map, probe, and policy files. |
| c11-90-primitive-restart-probe.mjs | lib | ACTIVE | 2026-08-16 | 4 | Shared driver for the C11-90 primitive-restart split harness: probe-base validation, watchdog budget, output/evidence paths, capture helpers. |
| c12-11-star-catalog-gate.mjs | gate-lib | ACTIVE | 2026-08-21 | 4 | Fail-closed contract, verdict fold, PNG envelope and artifact validation for the C12-11 star-catalog lane; the probe cannot self-attest. |
| c12-29-s4-orbital-sunrise-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 3 | Frozen constants and deterministic verdict arithmetic for the C12-29 S4 orbital-sunrise limb-glow acceptance; browser driver owns capture only. |
| c12-29-s5-custom-ellipsoid-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 7 | Frozen v7 contract plus independent f64/stepwise-f32 eclipse oracle for the S5 custom-ellipsoid certification; refuses self-attested evidence. |
| c12-29-s5-dense-cost-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 3 | Frozen experiment and fail-closed fold for the S5 dense ACTIVE/INACTIVE cost characterization (v3 schema, SHA-pinned workload). |
| c12-29-s5-multiview-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 4 | Frozen policy for the S5 same-context logical-View A->B->A shard; explicitly must not be cited as proof of engine multi-View scheduling. |
| c12-29-s5-replacement-device-capture.mjs | lib | ACTIVE | 2026-08-21 | 4 | Fail-closed AST/dataflow proof plus strict persisted-PNG decode for the replacement-device certification probe. |
| c12-29-s5-replacement-device-gate.mjs | gate-lib | ACTIVE | 2026-08-21 | 5 | Fail-closed acceptance for S5 replacement-device recovery after genuine Chromium GPU-process termination (v8 semantic-attestation/candidate-recovery schemas). |
| c12-29-s5-svs-footprint-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 7 | Gate library for the S5 NASA-SVS-5073 eclipse-footprint certification shard, pairing its probe and spec. |
| c12-29-s5-terrain-selection-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 4 | Frozen inputs, exact terrain-radius arithmetic, evidence-shape checks and verdict folding for S5's first final-certification shard (v10 schema). |
| c12-31-aureole-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 3 | Gate-predicate library for the C12-31 sky-aureole certification lane, pairing probe-sky-aureole-anchor with its spec. |
| c13-41-deckfree-control.mjs | lib | ACTIVE | 2026-08-16 | 2 | State-isolated ABBA session plan plus pinned lighting/fade constants for C13-41's deck-free eclipse control lane. |
| celestial-capture-harness.mjs | lib | ACTIVE | 2026-08-21 | 7 | Shared Playwright/page half of the celestial fleet: one pinned-clock settle recipe, warm-up-then-same-task capture, lane driver, PNG writer. |
| celestial-g1-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 10 | Pure verdict logic for the C12 G1 gate after six recorded repairs: per-backend non-vacuity, doubly-blind certifying mode voids the lane as STRUCTURAL. |
| celestial-g2-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 12 | Pure verdict logic plus display-transform inversion for G2 (star PSF, delivered magnitude range, C12-27 solar glare) on linearized captures. |
| celestial-g3-gate.mjs | gate-lib | ACTIVE | 2026-08-21 | 7 | Pure metrics and verdicts for G3 (star-map cube-face asset quality), criterion 2 re-pointed after DR-01 moved resolved stars to the sprite catalogue. |
| celestial-g4-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 8 | Pure metrics and verdicts for G4: sun disc size and limb law, C12-18 halo, C12-28 SDR policy, and the moon earthshine/soft-terminator acceptance. |
| celestial-metrics.mjs | lib | ACTIVE | 2026-08-16 | 12 | C12-01 metric library over RGBA buffers: M1 census, M2/M2e contrast + sky floor, M3 chroma, M4 falloff, M5 magnitude fidelity; 8-bit + HDR. |
| celestial-source-split.mjs | lib | ACTIVE | 2026-08-16 | 6 | Post-DR-01 G1 lane-A metrics: cube-map zero-resolved-source seam assertions plus sprite extent/agreement/chroma, zeros backed by controls. |
| cloud-coverage-response-model.mjs | lib | ACTIVE | 2026-08-16 | 3 | f32 CPU twin of the cloud coverage->density response (gate, BILLOWY gradient, Worley erosion, Beer-Lambert), importing the shipped response curve. |
| cloud-genus-morphology-model.mjs | lib | ACTIVE | 2026-08-16 | 7 | f32 CPU twin of C13-16 per-genus cloud morphology (wind frame, fallstreak shear, fibre carve); genus rows imported from CloudTypeProfile.js. |
| cloud-image-analysis.mjs | lib | ACTIVE | 2026-08-16 | 5 | Pure image analysis for C13 cloud probes: background subtraction, silhouette removal, morphology summary, directional autocorrelation of density. |
| cloud-march-transfer-model.mjs | lib | ACTIVE | 2026-08-21 | 4 | Node reconstruction of the camera-to-pixel cloud march (shell geometry, live density chain, saturating transfer) predicting the probe's estimator. |
| cloud-perf-evidence.mjs | lib | ACTIVE | 2026-08-16 | 2 | One-function pass policy for the fixed-scene cloud perf probe: a requested pair ID must never silently degrade to a single-artifact success. |
| cloud-probe-harness.mjs | lib | ACTIVE | 2026-08-16 | 25 | Self-contained browser-side helper (addInitScript) configuring defaultCloudCollection.volumetric and verifying every value round-tripped. |
| cloud-reconstruction-consume.mjs | lib | ACTIVE | 2026-08-16 | 3 | Browser-free half of the C13-10 acceptance: interleaved A/B schedule builder, null-not-zero pass-timing reads, and the FAIL-outranks-STRUCTURAL fold. |
| cloud-refresh-skip.mjs | lib | ACTIVE | 2026-08-16 | 5 | Shared enforceable home for the requestRenderMode refresh-skip defect that froze cloud snapshots and made three probe windows lie on one day. |
| cloud-tour-fixtures.mjs | lib | ACTIVE | 2026-08-16 | 6 | Deterministic C13-01 tour definitions: pinned local-solar clocks, absolute camera stations, replay keys, three-lane wind/time discriminators. |
| cloud-tour-metrics.mjs | lib | ACTIVE | 2026-08-16 | 3 | Pure C13-01 per-sequence metrics plus manifest validation, including assessInterleavedAb enforcing the C13-39 interleaved GPU-timing protocol. |
| cloud-u2-perf-evidence.mjs | lib | ACTIVE | 2026-08-21 | 3 | Manifest policy for the C13-16 U2 cross-bundle GPU-timing gate: comparison, environment-drift rejection, immutable evidence naming. |
| daynight-terminator-law.mjs | lib | ACTIVE | 2026-08-16 | 4 | Pure model behind probe-daynight-terminator-law (CLT-B1); deliberately unchanged post-fix, so lanes A/D now REFUTE — read metrics, not verdicts. |
| determinism-kit.mjs | lib | ACTIVE | 2026-08-16 | 11 | Probe determinism kit: pinClock, settleTiles, dampSky, nRunMedian — neutralises the four measured sources of run-to-run drift in visual probes. |
| eclipse-cloud-response-gate.mjs | gate-lib | ACTIVE | 2026-08-21 | 8 | C13-41 Edge-acceptance predicates with derived-never-fitted bands for deck lighting, cloud-shadow invariance, and the exact IBL refresh count. |
| eclipse-fixture-constraints.mjs | lib | ACTIVE | 2026-08-16 | 5 | All-lane constraint set for eclipse-sky vantage selection: per-candidate predicates with named rejections after headline-only selection failed. |
| engine-ts-resolver.mjs | lib | ACTIVE | 2026-08-16 | 17 | Node resolve hook rewriting engine-internal ./x.js specifiers to sibling .ts so specs can execute non-leaf engine TypeScript directly. |
| fog-cheap-coverage-model.mjs | lib | ACTIVE | 2026-08-16 | 5 | Bit-faithful CPU twin of the fog cheap cloud-shadow noise gate at real ECEF magnitudes, importing the shipped normalisation and coverage response. |
| globe-camera-track.mjs | lib | ACTIVE | 2026-08-16 | 13 | Shared orbit-to-ground camera route (plain serializable waypoints) used by both the visual parity probe and the performance campaign. |
| globe-pipeline-readiness.mjs | lib | ACTIVE | 2026-08-16 | 5 | Pure scoring for the pipeline-readiness probe: snapshot summary, coverage-divergence scoring, non-vacuity; keys decoded via canonical parser. |
| ground-fog-band-model.mjs | lib | ACTIVE | 2026-08-16 | 4 | Scene-geometry model for the ground-fog fix: WGS84 froxel-altitude reconstruction and the band optical-depth march at the probe's exact camera. |
| gsplat-classification-model.mjs | lib | ACTIVE | 2026-08-21 | 2 | Pure C15-G7 Gaussian-splat classification placement, route-counter, negative-control, and verdict arithmetic for the fleet probe. |
| gsplat-frame-variance-model.mjs | lib | ACTIVE | 2026-08-21 | 2 | Pre-registered D1-D5 gsplat frame-variance classifications with one immutable 0.050% bar and shared verdict exits. |
| gsplat-multifrustum-framing.mjs | lib | ACTIVE | 2026-08-21 | 1 | Pure far-nadir camera planning and real-PVS multi-frustum anti-vacuity/control logic for the Gaussian-splat parity probe's C15-G6 lane. |
| gsplat-parity-model.mjs | lib | ACTIVE | 2026-08-16 | 4 | Pure dual-mode verdict logic for probe-gsplat-parity: attributable-absence marker, presence flip, blank-canvas parity refusal, exits 0/1/2/3. |
| moon-mip-motion-certification.mjs | lib | ACTIVE | 2026-08-21 | 4 | Finalizer for C12-33-SHIMMER-ENVELOPE-CERTIFICATION: paired motion-shimmer separation, seam review, parity, and explicit non-claim of observed mip/LOD selection. |
| ocean-datum-model.mjs | lib | ACTIVE | 2026-08-16 | 7 | Pure-math verdict model classifying Cesium World Terrain's ocean-lid datum (ELLIPSOID_ZERO/GEOID/MIXED) for the tides/ocean-dynamics W0 gate. |
| ocean-tide-datum-model.mjs | lib | ACTIVE | 2026-08-16 | 5 | Published NOAA/ephemeris constants plus verdict logic accepting the geoid-anchor defect fix and the equilibrium-tide feature together. |
| owned-resource-transaction.mjs | lib | ACTIVE | 2026-08-16 | 2 | Dependency-free browser-safe helper that swaps an explicitly-owned resource transactionally (rollback on install failure, exactly-once destroy). |
| performance-campaign-utils.mjs | lib | ACTIVE | 2026-08-16 | 12 | Statistics/diff toolkit for the performance campaign: percentiles, counter-label diffs, run quality/stability, pacing and evidence summaries. |
| performance-viewer-url.mjs | lib | ACTIVE | 2026-08-16 | 5 | One-function helper building the offline CesiumViewer URL with the renderer query param for performance runs. |
| performance-workload-manifest.mjs | lib | ACTIVE | 2026-08-16 | 4 | AJV draft-07 validation of the performance workload manifest against the checked-in schema, shared so contract and runner accept one shape. |
| performance-workload-selection.mjs | lib | ACTIVE | 2026-08-16 | 4 | Selects runnable workloads per requested renderers; strict mode fails rather than silently dropping an explicitly requested renderer. |
| probe-fleet-contract-allowlist.mjs | lib | ACTIVE | 2026-08-21 | 8 | Pinned shrink-only census of pre-contract probes exempt from the fleet authoring contract; the spec fails on any NEW violation or stale row. |
| probe-fleet-contract.mjs | lib | ACTIVE | 2026-08-16 | 10 | Source-text analyzer enforcing the probe authoring contract (watchdog + finally-close); fails closed when it cannot parse a construct. |
| prohibited-reader-allowlist.mjs | lib | ACTIVE | 2026-08-21 | 2 | Pin the measured visual-regression sources that still use the prohibited live-canvas reader. |
| prohibited-reader-rule.mjs | lib | ACTIVE | 2026-08-20 | 4 | Detect drawImage calls that copy a live scene canvas into a scratch context. |
| provenance-markers.mjs | lib | ACTIVE | 2026-08-16 | 10 | Enforces bundler/formatter-proof provenance-marker strings for probes; encodes six recorded marker failure modes as shared validators. |
| purpose-header-allowlist.mjs | lib | ACTIVE | 2026-08-21 | 3 | Frozen shrink-only snapshot of the probes and gate libs that predate the @purpose/@status header rule. |
| representative-performance-content.mjs | lib | ACTIVE | 2026-08-16 | 10 | Builds and validates the local procedural terrain+models+tiles representative scene configuration for offline performance workloads. |
| representative-tileset-request-ledger.mjs | lib | ACTIVE | 2026-08-16 | 6 | Event-sourced ledger of tileset content requests (issue/terminal events, byte totals, hashes) with cross-run comparison for perf evidence. |
| same-task-capture.mjs | lib | ACTIVE | 2026-08-16 | 40 | Canonical capture primitives that keep render+readback in one task (WebGL clears, WebGPU invalidates after present), plus embed-drift validators. |
| settle-attribution.mjs | lib | ACTIVE | 2026-08-16 | 6 | First-complete-frame metric plus the rule that stable-time credit requires a main-thread long-task reduction (GPU-bound settles book none). |
| solar-bloom-glow.mjs | lib | ACTIVE | 2026-08-16 | 6 | Forward model of the sun bloom's additive glow-on-disc so differential disc measurements carry the non-cancelling bloom term correctly. |
| sun-radiance-delta.mjs | lib | ACTIVE | 2026-08-16 | 4 | Two-radiance sun-disc measurement model discriminating multiplicative gain vs additive pedestal via a parameter-free ratio statistic. |
| tidal-harmonics-model.mjs | lib | ACTIVE | 2026-08-16 | 1 | Published NOAA/Schureman constituent speeds, Doodson fundamental rates and physics-free signal helpers anchoring the tidal-harmonics spec. |
| verdict-exit-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 21 | Single frozen PASS/FAIL/ERROR/STRUCTURAL exit-code table shared by the S5 gate libraries; fixed a six-copy divergence where STRUCTURAL exited 2. |
| visual-evidence-library.mjs | lib | ACTIVE | 2026-08-16 | 5 | Schema, hashing and integrity-claim machinery for the content-addressed visual-evidence publication/catalog/verification pipeline (v2). |
| visual-gate-policy.mjs | lib | ACTIVE | 2026-08-16 | 12 | Manifest field requirements, stable stringify/sha256 and PASS/FAIL/NON_CERTIFYING policy shared by capture-and-diff and certification gates. |
| voxel-megatexture-reupload-gate.mjs | gate-lib | ACTIVE | 2026-08-16 | 3 | Browser-free convergence predicate for the voxel megatexture probe: first-corner resident set must republish within bounded return attempts. |
| weather-capture-doctrine.mjs | lib | ACTIVE | 2026-08-21 | 6 | Census weather-pin consumers and prove awaited immutable capture, live-canvas exclusion, and same-origin metric/documentary use through aliases and aggregates. |
| weather-probe-pinning.mjs | lib | ACTIVE | 2026-08-21 | 22 | Shared weather-probe determinism pins, ALL READ BACK from the live scene and the packed cloud uniform buffer, plus the canonical immutable same-frame capture; a pin that did not take is STRUCTURAL, never a product verdict. |
| weather-regional-tail-evidence.mjs | lib | ACTIVE | 2026-08-16 | 2 | Fixture and pass/fail policy for the C13-08 rendered antimeridian weather-tail probe, mutation-tested against its two target regressions. |
| webgpu-model-preparation-evidence.mjs | lib | ACTIVE | 2026-08-16 | 2 | Accumulates and validates WebGPU model preparation/demand counters as measurement-window evidence for performance workloads. |
| wgsl-variant.mjs | lib | ACTIVE | 2026-08-16 | 10 | Exposes the engine's real WGSL preprocessor and define registry so specs validate the exact variant text pipelines compile, not raw ifdef source. |

### scripts/ (2)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| patchEslintSeatbelt.mjs | other | ACTIVE | 2026-08-16 | 3 | postinstall patch normalizing eslint-seatbelt path keys to forward slashes so the committed POSIX seatbelt.tsv grandfathers on Windows. |
| run-build-no-tsc.mjs | runner | ACTIVE | 2026-08-16 | 8 | Dev build helper: converts WGSL then runs buildEngine/buildWidgets/buildCesium (development, unminified, sourcemapped) skipping tsc. |

### scripts/__tests__/ (5)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| bundleVariantPlugin.spec.mjs | spec | ACTIVE | 2026-08-16 | 3 | Exercises the build-variant alias plugin's onResolve decision matrix, compat exemption allowlist, re-entry guard and decision cache, no esbuild. |
| createIndexJs.spec.mjs | spec | ACTIVE | 2026-08-16 | 0 | Regression that the generated engine index omits private named-export temporal-history helpers yet still esbuild-bundles cleanly. |
| karmaTestRun.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Static coverage of the Gulp/Karma completion bridge via a fake Karma server: strict result config, retries, disconnect/error exit codes. |
| shaderSourceToJavaScript.spec.mjs | spec | ACTIVE | 2026-08-16 | 1 | Contract for the shader source-to-JS-module serializer: literal escapes, quotes, CRLF/lone-CR/U+2028 round-trips through real ESM evaluation. |
| specBundleFreshness.spec.mjs | spec | ACTIVE | 2026-08-16 | 2 | Coverage of the spec-bundle freshness sentinel: added/removed/changed spec files must flip the manifest comparison stale and name the offender. |

### scripts/archive/ (1)

| File | Class | Status | Touched | Refs | Purpose |
|---|---|---|---|---|---|
| codemod-split-material-ubo.mjs | other | INVESTIGATION | 2026-08-16 | 2 | One-time codemod splitting monolithic WGSL 'struct Uniforms' into CameraUniforms/MaterialUniforms with separate bind groups. |

<!-- END GENERATED CENSUS -->
