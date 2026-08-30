# DX-15 translucent-classification composite-scaffold removal preregistration

**Date:** 2026-08-30  
**Canonical campaign row:** `C11-107` / ADR-2026-04-28 retirement tail  
**Dispatch alias:** `DX-15`  
**Status:** **PREREGISTRATION / PREPARATION ONLY — NO-GO TO IMPLEMENT, DELETE, RUN EDGE, LAND, OR CERTIFY**

This document freezes the proof required before the inline translucent-classification color/composite
scaffold can be removed. It does not authorize a writer, deletion, build, browser run, evidence
publication, or Git action. The explicit `C11-107` / G6 Q2d Principle-7 maintainer sign-off to retire
the scaffold is still owed. Broad Wave DX authority is not that specific sign-off.

## 1. Identity, authority, and current verdict

`DX-15` is an add-only execution alias for the cleanup tail of canonical Campaign-11 row
`C11-107`. It does not replace, renumber, or reopen another row.

`DX-14` already identifies the parked/banked `TOOLING_CATALOG.md` archive-plan generator work. Its
authoritative record is the section headed **“DX-14 parked after two pasted turns”** in
`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`; `CODEX_HANDOFF_2026-08-29.md` also names it as the parked
catalog archive plan. `DX-14` remains unchanged and is not an alias for this work.

The architectural premise is strong but is not execution authority:

- `DEFERRED_WORK.md` records that the depth-sampling classifier replaced the
  stencil/accumulation design and that Session 5 scheduled removal of the obsolete Batch-47
  color/composite scaffold.
- `QUEUE_2026-07-18_CAMPAIGN11.md` records: **“ADR accumulation complete-vs-retire
  (`C11-107`, G6 Q2d): retire needs explicit Principle-7 sign-off.”**
- Current source has an unresolved pass-order contradiction. In
  `WebGPUSceneRendererFrustumLoop.ts`, the unique comment beginning **“After Pass.TRANSLUCENT,
  refresh the reusable packed depth view”** says publication occurs after that frustum's regular
  classification and cannot feed the same-frustum dispatch. In
  `WebGPUGroundPrimitiveRenderer.js`, the unique comment beginning **“The per-frustum bind-group
  resolver follows depth-source publications”** says each frustum updates the views before
  classification. The forced-multifrusta oracle below must adjudicate reality.

Current verdict: **NO-GO** to implementation, deletion, Edge release, landing, or certification.
A repo-only reference census supports this preparation packet; it cannot prove external
deep-import non-use or runtime correctness.

## 2. Survey tuple and claim boundary

This preparation lane was prohibited from using Git, so it makes no source-commit or dirty-state
claim. The future validation manifest must supply both. These identities record only the source
survey read for this preregistration; they are not an implementation freeze or certification
manifest.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts` | 31,148 | `1E66A46A7945163AE30DB7B2EC6A0A36E04AEF34A831CC16462276F237734B24` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts` | 27,103 | `B28B03E62FE8EF4A33AEC6D6E91AC4E6ACA4492ABCF823B6519D7C57001F045A` |
| `packages/engine/Specs/Renderer/WebGPU/WebGPUSceneRendererDependentResourcesSpec.js` | 9,111 | `E1D1A7A2DE21BEE76CC14E5A575524D9C2948B22944CA03CAD97F58829AE0113` |
| `packages/engine/Source/Shaders/WebGPU/PostProcess/CompositeTranslucentClassification.wgsl` | 1,232 | `1B41790943D09DAA18AFA069F5DD2DB571E5ECB59D19532F41B3029CC9FCA6FD` |
| `packages/engine/index.js` | 179,824 | `58842839AB50CCDEA7D7FA7BEEC036EB54DF5B6216633C63C51497541D786689` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts` | 27,483 | `F9F12060673AB2921063D68F714137DFCE171D589DC0140580AE9702DE7A2125` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrameReset.ts` | 3,953 | `0C52A8F1468BBE7A0F70E8DA969D2E251947105DC7B27948817D0230B5326293` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js` | 125,402 | `0F8D98F57BD4D8A0E6DC99276E05DEEDD4857E65DEA375FCAC66F127380C0876` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUGroundPolylineRenderer.js` | 129,518 | `0427EDDAB381D58945EB8F6D1DF5218ED0F597BDFFDEA763D2CB036D8D84D5D0` |
| `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` | 320,597 | `4CF8589D28F9C506DFE1C085E3F9B44118E54D003FE06A9FF3C8996E31A0A676` |

The deletion candidate is limited to the inline scaffold in
`WebGPUTranslucentTileClassification.ts`:

- inline `COMPOSITE_WGSL`;
- `_colorFormat` and the color-format-only `update` dependency;
- `_classificationColorTexture` and `_classificationColorView`, including allocation and teardown;
- `_compositePipeline`, `_compositeBGL`, `_compositeBindGroup`, and
  `_compositeShaderModule` lifecycle;
- public `composite()` and private `_ensureCompositePipeline()`;
- only the corresponding dead color-format argument at the `ensureResources` call site and its stale
  allocation comment.

The current production-source census, excluding documentation, generated output, and this
preregistration, finds those inline classification-color/composite symbols only in their defining
module and finds no shipped internal call to this class's `composite()` method. That is repository
evidence of internal non-use, not proof that an external consumer never deep-imported the private
module.

## 3. Future ownership and exact path leases

No future lease opens until the explicit `C11-107` / G6 Q2d retirement sign-off is durably recorded
and root collision-checks every path against the then-current shared tree.

After sign-off, one implementation writer may own exactly:

1. `packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts`
2. `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts`
3. `packages/engine/Specs/Renderer/WebGPU/WebGPUSceneRendererDependentResourcesSpec.js`
4. `Tools/visual-regression/probe-translucent-classification-scaffold-retirement.mjs`

The existing Jasmine spec has a runner home through `packages/engine/Specs/SpecList.js` and
`npm test`. The probe is the direct feature measurement preferred by `R-2026-08-29-1`; it must carry
the purpose/status header and fleet lifecycle contract. Another source-inspection spec is not a
substitute for the pixel oracle.

A separate documentation writer, serialized after the implementation writer freezes the post-patch
source and non-browser-result tuple and before reviewer A, may own exactly:

- `migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md`
- `migration_doc/QUEUE_2026-07-18_CAMPAIGN11.md`
- `migration_doc/DEFERRED_WORK.md`
- `migration_doc/FEATURE_INVENTORY.md`
- `migration_doc/ISSUES_AND_FIXED_BUGS.md`
- `migration_doc/DEV_NOTES_primitives_classification.md`
- a new, root-approved DX-15 branch handoff/removal-record path

After Edge evidence freezes, root may reopen the same exclusive documentation lease only to add final
evidence/status pointers. The complete landing tuple then freezes before reviewer B.

If the probe requires catalog regeneration, `migration_doc/TOOLING_CATALOG.md` is a root-owned
integration output and joins the reviewed landing tuple; it is not permission for the implementation
writer to edit or generate it. A newly discovered required source path is scope drift: stop, record
it, and obtain a replacement lease and fresh preregistration review before editing.

## 4. Protected surfaces and hard exclusions

The following are live or separately governed and must remain byte-identical in the candidate except
for disposable, explicitly identified mutant trees:

- `_sampler`: the single-sample pack pipeline binds it at slot 2 and creates it in
  `_ensurePackPipeline()`.
- `_translucentDepthTexture`, `_translucentDepthSampleableView`, `_packedDepthTexture`,
  `_packedDepthView`, `packedTranslucentDepthView`, both pack pipelines/shaders, all per-frame
  flags, and every capture/pack method.
- `_translucentDepthView`: it looks unused, but it is explicitly outside this bounded decision.
- packed-depth publication/reset in `WebGPUSceneRendererFrustumLoop.ts` and
  `WebGPUSceneRendererFrameReset.ts`.
- packed-depth consumers in `WebGPUGroundPrimitiveRenderer.js`,
  `WebGPUGroundPolylineRenderer.js`, `WebGPUVector3DTilePrimitiveRenderer.js`, and
  `WebGPUVector3DTileClampedPolylinesRenderer.js`.
- `WebGPUContext._packedTranslucentDepthView` and all command/flag plumbing.
- every WebGL implementation and shader.
- every `ShaderDefine` and `ShaderSourceId` entry: neither add-only registry may be removed,
  reordered, or renumbered.

The standalone
`packages/engine/Source/Shaders/WebGPU/PostProcess/CompositeTranslucentClassification.wgsl` is a
distinct decision. The build generates its `.js` sibling and `packages/engine/index.js` publicly
exports `_shadersPostProcess_CompositeTranslucentClassification`; the GLSL shader is also a separate
public surface. None belongs to DX-15. Inline-string non-use does not prove that the public shader
export is unused.

## 5. Deep-import compatibility and removal rationale

`WebGPUTranslucentTileClassification` is marked private and is absent from the package barrel and
types, but the package ships `Source` without an exports map, so toolchain-specific raw `.ts` deep
imports remain possible. Removing public method `composite()` and narrowing `update()` is a
low-to-moderate private-source compatibility risk that repository search cannot eliminate.

The maintainer's explicit Principle-7 sign-off must acknowledge that risk; otherwise the writer
stops rather than silently retaining a no-op shim or silently removing the method. The landing record
must state the repo-only census and its limits, that the class/export and all packed-depth behavior
remain, that the private deep-import surface was intentionally retired, and that the separately
public shader stays unchanged.

The removal is useful because it eliminates one eager full-canvas texture/view, dead HDR-format
recreation of both live depth resources, and misleading lifecycle code after the depth-sampling
architecture made color accumulation obsolete. It also removes the internally uncalled lazy
shader/pipeline/bind-group path. Repository source has no shipped caller, but raw private-module deep
imports could still reach it; therefore the guaranteed runtime savings are the color target and
avoided HDR churn—not an already-created composite pipeline.

## 6. Preregistered source and resource gates

The behavior harness must execute the real class against a strict fake `GPUDevice`; source grep alone
is not acceptance. The candidate passes only if:

1. Initial `update(device, width, height)` creates exactly **two textures**: translucent depth and
   packed depth, with zero classification-color textures.
2. It creates exactly **three views**: retained `_translucentDepthView`, the depth-only sampleable
   view, and the packed-depth view.
3. Repeating the identical device/size tuple creates and destroys nothing.
4. An HDR-only scene-color-format flip does not recreate classifier targets; the classifier tuple
   no longer contains color format.
5. A size change or device replacement destroys exactly the two old live textures once and creates
   exactly two replacements.
6. A fresh 1x path creates one live sampler, binds it at slot 2, executes one pack draw, and
   publishes a non-null packed view.
7. A fresh 4x path executes exactly one MSAA pack draw without depending on a sampler.
8. `destroy()` destroys the two current textures exactly once.
9. No inline composite shader module, BGL, bind group, pipeline, render pass,
   classification-color target, or public `composite` surface remains.
10. Every excluded-path hash matches its frozen pre-patch identity.

Source comments left under `packages/engine/Source` must describe the resulting packed-depth
mechanism and constraints in seamless upstream voice. They must not mention DX-15, batches, cleanup,
reviewers, or dates.

## 7. Deterministic pixel matrix

The existing `packages/sandcastle/gallery/webgpu-translucent-classification/main.js` is not
acceptable unchanged as the oracle: it hardcodes WebGPU, permits remote-Ion/fallback subject drift,
and styles the tileset opaque with `color('white')`. The new probe must construct a
backend-selectable, deterministic local fixture with two translucent tile surfaces in distinct,
disjoint regions of interest. It must force opacity below one and prove that flagged
`Pass.TRANSLUCENT` commands actually exist.

The scored matrix is fixed:

| Backend | MSAA | Frustum mode |
| --- | ---: | --- |
| WebGPU | 1x | ordinary |
| WebGPU | 4x | ordinary |
| WebGPU | 1x | forced at least two relevant slices |
| WebGPU | 4x | forced at least two relevant slices |
| WebGL negative control | 1x | ordinary |
| WebGL negative control | 4x | ordinary |
| WebGL negative control | 1x | forced at least two relevant slices |
| WebGL negative control | 4x | forced at least two relevant slices |

Every forced lane must record at least two frusta, both with 3D-tile classification commands and
flagged translucent commands, distinct near/far ranges, per-frustum packed
publication/consumer witnesses on WebGPU, and a nonempty classification mask in each ROI. A
classification-disabled capture is required in every cell and must differ from classification-on
pixels, so an empty or inert fixture cannot pass.

This is a no-behavior-change deletion. The independently derived threshold is **zero**:

- each post-cleanup cell must reproduce the same-backend pre-cleanup decoded RGBA bytes and
  classification mask exactly;
- each post-cleanup WebGL-vs-WebGPU diff artifact must reproduce its pre-cleanup counterpart exactly;
- page, console, WebGPU-validation, device-loss, and unhandled-error arrays must be empty; and
- no tolerance may be learned from or widened after the certifying run.

Missing local subject, remote/fallback substitution, no flagged translucent command, fewer than two
relevant forced frusta, missing publication/consumer order, empty control delta, missing ROI, or an
unscored pixel is `STRUCTURAL`, never PASS.

The pass-order contradiction in section 1 is a measured premise. If a valid baseline proves a
wrong-slice, stale-slice, or same-frustum classification defect, that is visible `FAIL` and a separate
C11 repair. DX-15 does not broaden itself into that repair or delete around it.

## 8. Frozen seven-mutant topology

The seven mutants below are add-only for this preregistration. Root prepares and freezes each mutant
patch in a disposable, hash-identified derived tree; the Edge steward only executes the released
immutable trees. Mutant application failure or wrong-source identity is `STRUCTURAL`.

1. **M1 — color allocation.** Reintroduce a throwaway classification-color texture/view after
   cleanup. Expected: the exact resource-count gate is `FAIL`.
2. **M2 — no-call proof on the pre-cleanup baseline.** Make `composite()` /
   `_ensureCompositePipeline()` throw, or invalidate inline `COMPOSITE_WGSL`. Expected: every normal
   runtime matrix leg remains green. Any invocation is an immediate stop condition proving the
   scaffold is called and invalidating the removal premise.
3. **M3 — publication null.** Force packed-depth publication to `null`. Expected: forced-multifrusta
   consumer and pixel gates are `FAIL`.
4. **M4 — packed output cleared.** Force packed output to all-zero/far depth. Expected: the same
   consumer and ROI gates are `FAIL`.
5. **M5 — wrong consumer preference.** Make classifier consumers prefer globe depth over packed
   translucent depth. Expected: the same consumer and ROI gates are `FAIL`.
6. **M6 — disable MSAA pack.** Suppress the MSAA pack path. Expected: both WebGPU 4x cells are `FAIL`
   while the 1x controls remain valid.
7. **M7 — stale first view.** Pin the first packed view or suppress later per-frustum publication.
   Expected: forced-multifrusta slice/ROI gates are `FAIL`.

If M3, M4, or M5 survives, stop: packed depth has not been proven load-bearing and the deletion
remains NO-GO. `_sampler`, `_translucentDepthView`, and packed-depth source are protected boundaries,
not alternate members of the seven.

Additional sensitivity control outside the fixed seven: disable the WebGL classification primitive.
Every WebGL cell must turn red, proving the negative-control backend is genuinely measured.

## 9. Verdict fold and exit codes

The final result folds once from retained primitives using the repository-wide contract:

- **PASS / exit 0:** explicit sign-off exists; every source/resource predicate, all eight matrix
  cells, M1–M7 expectation, WebGL sensitivity control, provenance/lifecycle prerequisite, cleanup
  predicate, and both independent post-patch reviews pass; nothing is missing or unscored.
- **FAIL / exit 1:** a valid, complete measurement misses any registered resource, identity, pixel,
  error-surface, pass-order, or mutant expectation. A measured red remains red.
- **ERROR / exit 2:** an exception, device loss, browser/runtime failure, exhausted operation
  deadline, or incomplete teardown prevents a trustworthy completed measurement.
- **STRUCTURAL / exit 3:** sign-off absent; source or tuple drift; stale/missing build;
  served-source mismatch; wrong or missing local fixture; absent subject/command/slice/ROI/order
  witness; malformed/incomplete artifact; missing provenance/review; unbound dirty state; or
  unauthorized Edge state.

The present preparation state is not a gate invocation and carries no exit-code result. It is
`PREREGISTRATION / PREPARATION ONLY` and `DECLARED_UNVERIFIED` for runtime behavior.

## 10. Clean-manifest and evidence prerequisites

Before a real run, the clean validation manifest must bind all of the following in both directions:

- exact DX-15 / C11-107 claim and durable maintainer sign-off identity;
- base and candidate source commits, dirty states, complete transitive source boundaries, byte
  counts, and SHA-256 values;
- exact baseline, candidate, and mutant patches plus resulting source tuples;
- local build identity and browser-served bytes for every bundle/resource consumed;
- deterministic fixture and asset identities, proving no remote/fallback subject ran;
- probe, policy, Edge, adapter, driver, backend, MSAA, and frustum identities;
- every invocation and outcome, including FAIL, ERROR, STRUCTURAL, aborted, and mutant runs;
- raw page/console/WebGPU-validation/device-loss/unhandled-error surfaces;
- same-render readiness, classification mask, score, ROI, and image witnesses;
- persisted and independently re-decoded image/report hashes;
- bounded process/browser teardown and descendant quiescence;
- unrelated dirt identified by stable baseline and proven outside the transitive boundary; and
- both post-patch review identities, terminal rehashes, findings, and dispositions.

No baseline refresh may occur inside the certifying run. Evidence is first banked under
`Tools/visual-regression/output/dx15/<run-id>/` and, if certification is later authorized, copied
through the immutable publication lifecycle. A manifest does not become clean by omitting a red run.

## 11. Review, Edge, and landing sequence

1. Obtain and durably record the explicit `C11-107` / G6 Q2d retirement sign-off.
2. Root collision-audits and opens the exact leases; no worker self-assigns them.
3. Freeze the pre-cleanup source/build tuple and root-prepared M2 derived tree. Do not execute its
   browser matrix before the gated Edge release.
4. The implementation writer changes only the four implementation-lease paths, runs authorized
   non-browser gates, and freezes the post-patch source and non-browser-result tuple. The
   documentation writer then prepares and freezes the pre-Edge rationale/status tuple.
5. **Post-patch reviewer A**, a fresh Tolkien-named agent independent of both writers and the
   preregistration authors, audits reachability, exact removals, resource behavior, protected/public
   surfaces, deep-import disposition, and documentation. It terminally rehashes and returns
   GO/NO-GO.
6. Only after reviewer A GO does root prepare and freeze the remaining hash-identified derived
   trees, verify their source identities, and explicitly release the separate, serialized Edge lane
   to the designated tier-2 Sol Edge steward. Both writers and the reviewers do not run the browser.
7. The Edge steward alone executes and banks M2 against the frozen pre-cleanup baseline, the
   ordinary/forced, 1x/4x, both-backend candidate matrix, and the authorized released mutant trees,
   then proves cleanup/quiescence.
8. After Edge evidence freezes, the documentation writer adds only final evidence/status pointers.
   Freeze the complete evidence manifest and landing tuple.
9. **Post-patch reviewer B**, fresh and independent of both writers, reviewer A, the Edge executor,
   and the preregistration authors, terminally rehashes, independently recomputes the fold, inspects
   every artifact and mutant, and returns GO/NO-GO.
10. Any finding reopens ownership. Repair, rerun affected gates, refreeze, and obtain fresh A and B
    reviews. Conditional approval with an unresolved requirement is NO-GO.
11. Only root may materialize, stage, or commit the exact reviewed tuple. Campaign-11 status,
    DX-15 status, feature/deferred records, and removal rationale land atomically or in an
    immediately linked governed documentation batch. No push occurs without separate user review
    and authority.

The two preregistration reviewers establish only that this is a defensible future proof plan. They
do not count as the two required post-patch approvals.

## 12. Present nonclaims and stop conditions

- No code was removed or changed by this preparation lane.
- No test, build, browser, Edge, server, network, install, evidence-publication, or Git action ran.
- No runtime, pixel-equivalence, multifrustrum, resource-saving, performance, compatibility, or
  certification claim is made now.
- The documented depth-sampling replacement and Session-5 removal schedule establish the
  architectural removal premise; they do not establish current runtime correctness or supply the
  explicit retirement sign-off.
- If sign-off remains absent, a required path drifts, the forced fixture is not locally
  deterministic, the pass-order baseline is red, a protected path must change, M2 detects a call,
  or M3–M5 survives, stop and leave the deletion NO-GO.
