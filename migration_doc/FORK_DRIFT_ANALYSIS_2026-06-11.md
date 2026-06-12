# Fork-Drift Analysis & Decision (2026-06-11)

**Scope:** our WebGL/core fork vs upstream CesiumGS/cesium.
**Inputs:** the 2026-06-11 dual-axis ultra-review (Axis B, `audits/2026-06-11_ULTRA_REVIEW.md` + `_findings.json`) + a direct upstream changelog/diff pass.
**Baseline:** merge-base `0becdbfc17`; upstream/main `467919ca90` (v1.142, 2026-06-01). Divergence: 284 upstream commits / 435 ours; **552 upstream files modified by us**, **193 upstream files modified by upstream** since the merge-base.

---

## 0. Decision lens (set by the project owner, 2026-06-11)

> "We want to be fixing forward and improving the product. We should only look at integrating upstream changes if they actually improve our fork. Important things from upstream are **fixes and new features**, then **restoring the JSDoc**, and **fixing Context/PickId** if the result is a better, more modern, durable product. Future merge cost might not matter."

This **rejects the ultra-review's headline Axis-B recommendation** (`NEW-FORK-MODERNIZATION-REVERT` — "revert ~15 cosmetic ES6 conversions to cut merge conflict surface"). Merge-cost-minimization is **not** a goal here. The fork's ES6/TS modernization is part of the product direction (CLAUDE.md mandates it on touched files) and stays. This document re-scopes Axis B around **value pulled in** and **defects fixed forward**, not diff-shrinking.

What changes vs the review:
- **DROP** `NEW-FORK-MODERNIZATION-REVERT`, `NEW-CAMERA-UPDATEVIEWMATRIX-REVERT` (revert-to-upstream items) as *recommendations*. (They remain in the inventory as "considered, declined" so a future owner sees the call was deliberate.)
- **KEEP & RAISE** the upstream-value pulls, the regression fixes, and the JSDoc/comment restoration.
- **RE-FRAME** Context/PickId from "pre-stage the merge conflict" to "adopt upstream's structure only where it's a durability/architecture win."

---

## 1. Pull IN from upstream — fixes & features that improve our fork

Upstream shipped v1.142 (2026-06-01) since our merge-base. These are the items worth cherry-picking/porting **on their own merit** (not for merge hygiene), ranked by relevance to our fork. Each should be evaluated against our forked version of the file (some of these files we rewrote, so it's a port, not a clean cherry-pick).

| Priority | Upstream change | PR | Why it improves our fork |
|---|---|---|---|
| **P1** | `pickModel`: fixed incorrect matrix multiplication for non-worldspace instance transforms; fixed `ModelReader.octDecode` arg order (`octDecodeInRange`/`Cartesian3.pack`) | #13433 | Directly correctness-relevant — we're actively working picking (Batch 221). Our model-pick path should carry these fixes; verify against our forked `Model.js`/picking. |
| **P1** | `BufferPointCollection` not updating after point-position changes | #13465 | Collections are an active fork area (Batches 218–220). Real data-staleness bug; port into our `Buffer*` collection path. |
| **P1** | Empty `imageryLayers` array wrongly triggers `ImageryPipelineStage` (`hasImageryLayers` must also check `.length > 0`) | (Axis-B `NEW-UPSTREAM-IMAGERYLAYERS-EMPTY-GUARD`) | ✅ **SHIPPED (Batch 237)** — guard ported into `ModelRuntimePrimitive.configurePipeline` (upstream-identical), + 2 specs + `Tools/upstream-regression-check.mjs` item [1] with negative control. |
| **P2** | Stale `showsUpdated` persisting when entities are removed from ground-primitive batches | #13366 | We've touched ground-primitive classification heavily (Batch 173/184). Port to keep batch state correct. |
| **P2** | `DeveloperError` on 3D tiles with degenerate (zero-area) triangles + edge-visibility data | #13421 | We added edge-visibility (WebGPU) — the WebGL/core guard should match. Verify our edge path has the same guard. |
| **P2** | Lighting affecting `EquirectangularPanorama` | #13369 | Panorama is in our feature set; correctness port. |
| **P3** | EXT_structural_metadata properties in **vector tilesets** | #13426 | New feature. Adopt if vector tiles are on our roadmap (cross-ref FEATURE_INVENTORY). |
| **P3** | `OffscreenCanvas` as `ImageryTypes` | #13297 | New capability, low-risk additive; good for headless/worker (cross-ref OPTION_B_SCENE_IN_WORKER). |
| **P3** | `npm run sg-scan` JSDoc/type lint step | #13377 | Tooling that would *catch the JSDoc loss in §3*. Worth adopting as a guard. |
| **Note** | `BufferPrimitiveCollection.modelMatrix`/`boundingVolume`/`boundingVolumeWC` now **readonly**; min Node bumped to **22** | #13448 | **Breaking changes** — flag for the next upstream sync; our `Buffer*` code + CI Node version must align. Not a "pull in now," but a sync-planning item. |

**Method note:** these are from upstream's `CHANGES.md` delta. A complete pull would also scan the 193 upstream-modified engine files for un-changelogged fixes; recommend a targeted `git log 0becdbfc17..upstream/main -- <subsystem>` per active subsystem at integration time rather than a blanket merge.

---

## 2. Fix FORWARD — regressions OUR modernization introduced

The ultra-review found the big ES6-modernization pass shipped real behavioral regressions (predictable fallout of a codemod-scale change). These are **bugs to fix in our code** — independent of any revert decision. Fixing forward (correcting the class/TS version) is the right move, not reverting to upstream's function form.

- **`Resource.contains`** — behavioral regression vs upstream (Axis-B). Verify + fix the comparison/normalization logic in our `Core/Resource.js`.
- **`TimeIntervalCollection.contains`** — behavioral regression vs upstream (Axis-B). Verify + fix.
- **`Animation.js` childNodes text-node bug** — the widget modernization mis-handled DOM `childNodes` (text nodes), an actual UI bug. Fix in our `widgets/Source/Animation/Animation.js`.

> **Action:** add `NEW-FORK-MODERNIZATION-REGRESSIONS` to DEFERRED_WORK with these three as concrete sub-items + a verifying test each (diff our logic against upstream's for the specific method, write a unit test that upstream would pass).

These three are the **highest-value Axis-B items** under the fix-forward lens: they're live defects, not cosmetic drift.

> **✅ RESOLVED (Batch 237) — verify-then-fix outcome.** (a) `Resource.contains` does not exist as a method in either tree — the label conflated Axis-B findings; the documented Resource regressions were `parseUrl` (Session 35, already fixed). The verification however surfaced a **third, still-live `parseUrl` divergence**: the no-scheme/no-base branch dropped protocol-relative authority (`"//host/"` → `"/"`, failing `ArcGisMapServerImageryProviderSpec` on main) and re-rooted bare-relative URLs (`"Assets/foo"` → `"/Assets/foo"`). Fixed forward (verbatim-minus-query/fragment, upstream urijs semantics); `gulp test --includeName Resource` 397/397 (was 1 FAILED). (b) `TimeIntervalCollection.contains` already fixed (`17441c3af9`), upstream-identical — no change. (c) `Animation.js` already patched (flush-left + prettier-ignore), literal byte-identical to upstream — no change. All locked by `Tools/upstream-regression-check.mjs` (18 checks) + 2 new `ResourceSpec` specs. See DEFERRED_WORK `NEW-FORK-MODERNIZATION-REGRESSIONS` for full evidence.

---

## 3. Restore — JSDoc / rationale comments dropped during modernization

The modernization stripped public-API documentation that feeds cesium.com's API docs and TS consumers. Restoring it is pure upside (the project rule is "preserve ALL existing JSDoc"). No revert needed — re-add the docblocks onto our class/TS form.

- **`NEW-CAMERA-JSDOC-RESTORE`** (HIGH) — ~80% of public-API JSDoc/`@example` lost on `Camera.js` / `ScreenSpaceCameraController.js` (`setView`/`lookAt`/etc.). Re-add the shipped `@example` blocks + full `@param` prose.
- **`NEW-SHADOWMAP-COMMENT-RESTORE`** (MED) — ~40–50 stripped WHY-comments in `ShadowMapComputations` (cascade split-mix, light-space sign convention, perspective-divide, resize diagram). Re-add — these are load-bearing for anyone touching CSM (our CSM work depends on this math).
- Adopt upstream's **sg-scan** lint (§1 P3) so future JSDoc loss is caught in CI.

---

## 4. Context / PickId — adopt upstream only where it's a durability win

The review flagged `NEW-CONTEXT-PICKID-MERGE-PRESTAGE` (the one *active* merge conflict today: `Context.js` content + `PickId.js` add/add). Under the fix-forward lens the question is not "pre-stage the merge" but **"is upstream's structure better, more modern, more durable than ours?"**

Assessment:
- **`Context.js`** — our fork intentionally converted it to an ES6 class `extends GraphicsContext` (the backbone of the dual-backend abstraction). That is a **deliberate, superior** architecture for our goals; we keep it. At the next sync, upstream's `Context.js` changes get **hand-ported into our class form**, not the reverse. **No change now.** (This is the one place the "MOVE-MAP" idea has merit — see §5.)
- **`PickId.js`** — review notes upstream's class body has richer `@import`/`@implements` typing. If upstream's `PickId` typing is genuinely cleaner AND our fork only added `normalizedRgba`/`pickKinds`, then **adopt upstream's class as the base and re-apply our two deltas** — that's a durability/typing win, not a merge concession. **Action:** diff our `PickId.js` against upstream; if the delta is just those two additions, take upstream's body + re-apply. Otherwise keep ours.

Net: Context stays ours (better); PickId is a candidate to rebase onto upstream's typing **iff** our delta is small — evaluate at integration time.

---

## 5. Lightweight sync hygiene (keep, because it helps US — not to shrink diffs)

The only "drift-management" items worth keeping are the ones that reduce **our** future pain when pulling upstream value (§1), regardless of merge-cost philosophy:

- **`NEW-SYNC-MOVEMAP`** (MED) — for the few files we heavily restructured (Scene.js → companion files, Context.js → GraphicsContext), add a one-line header MOVE-MAP + a runbook table so an upstream fix to a gutted region is *routed to the right helper* instead of re-discovered each time. This is about not LOSING upstream fixes (§1), not about merge cost.
- **`NEW-WEBGL-REPROJECT-BASELINE`** (HIGH) — our WebGL imagery reprojection forked to per-fragment Mercator (64-row-grid → 4-vertex-quad). That's a deliberate fork change, but it forks WebGL *pixel output* from upstream silently. Add a visual-regression baseline so we KNOW when our WebGL output diverges from upstream's (catches accidental drift on top of the intentional change).

---

## 6. Explicitly NOT doing (and why)

- **Mass-reverting the ES6/TS modernization** (`NEW-FORK-MODERNIZATION-REVERT`, ~15 files) — declined. Modernization is product direction; merge-cost is not a goal. The conversions stay.
- **Reverting `Camera` ctor `updateMembers`→`updateViewMatrix`** (`NEW-CAMERA-UPDATEVIEWMATRIX-REVERT`) — declined as a revert. BUT verify it isn't a **functional** regression (does the ctor still seed the view matrix correctly?). If it's only stylistic, leave it; if it short-circuits view-matrix seeding, fix forward (not revert).
- **Pre-emptive upstream merge** — not now. We pull specific value (§1) on demand. A full merge happens when the accumulated upstream value justifies it, planned with the §1 breaking-changes list (Node 22, BufferPrimitiveCollection readonly).

---

## 7. Prioritized actions (fix-forward order)

1. **`NEW-UPSTREAM-IMAGERYLAYERS-EMPTY-GUARD`** — port the `hasImageryLayers && length>0` guard (P1, one-liner, affects WebGL).
2. **`NEW-FORK-MODERNIZATION-REGRESSIONS`** — fix `Resource.contains`, `TimeIntervalCollection.contains`, `Animation.js` text-node (with a unit test each).
3. **`pickModel` fixes** (#13433) — port the matrix + octDecode fixes into our model-pick path (pairs with the Batch-221 picking work).
4. **`BufferPointCollection` update fix** (#13465) — port into our `Buffer*` collections.
5. **`NEW-CAMERA-JSDOC-RESTORE`** + adopt **sg-scan** lint — restore public-API docs + guard against re-loss.
6. **`PickId.js` rebase assessment** — diff vs upstream; adopt upstream body iff our delta is small.
7. **`NEW-SHADOWMAP-COMMENT-RESTORE`**, **`NEW-WEBGL-REPROJECT-BASELINE`**, **`NEW-SYNC-MOVEMAP`** — restore CSM rationale, add reprojection baseline, add MOVE-MAP.
8. **Ground-primitive `showsUpdated`** (#13366), **degenerate-triangle edge guard** (#13421), **panorama lighting** (#13369) — port as we touch those subsystems.
9. **Sync-planning note:** Node 22 minimum + `BufferPrimitiveCollection` readonly props are upstream **breaking changes** for the eventual sync.

---

*Cross-references: `audits/2026-06-11_ULTRA_REVIEW.md` (full Axis-B findings), `DEFERRED_WORK.md` (NEW-* IDs), `WEBGPU_MIGRATION_STATUS.md` (Upstream Sync Procedure).*
