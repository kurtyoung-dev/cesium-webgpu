# Upstream Merge v1.142 — Change Log & Regression Targets (2026-06-17)

**Purpose:** record every conflict resolution made during the supervised hybrid merge of
upstream `CesiumGS/cesium` into this WebGPU fork, so the changed surfaces can be
regression-tested. For each file: what we **kept from our fork** (must not regress) and what
**upstream behavioral fix we adopted** (the regression target to exercise).

## Merge metadata

| | |
|---|---|
| Merge-base (common ancestor) | `0becdbfc17` |
| Upstream tip merged | `upstream/main` @ `11f203fb02` (v1.142 line) |
| Our tip before merge | `14f1369c73` (Batch 314) |
| Divergence | upstream **+709** / ours **+548** |
| Safety / rollback ref | `pre-upstream-merge-2026-06-16` @ `14f1369c73` |
| Total conflicted files | **68** |
| **WebGPU renderer conflicts** | **0** (our renderer is purely additive — `Source/Renderer/WebGPU/**`, `Source/Shaders/WebGPU/**` all clean) |
| Force-push | **HELD for owner review** (two-parent merge commit, not yet pushed) |

## Dependency reconciliation (npm install)

Upstream v1.142 brought a new tooling stack (ESLint 10 + `@cesium/eslint-config@14` +
`@ast-grep/cli` + `eslint-seatbelt@0.1.x`, Playwright bump, `vite-plugin-static-copy ^3.4→^4.1`).
Our `package-lock.json` was stale against the merged `package.json`, so `node_modules` had to be
re-synced before the build would pass.

- **`npm install` (plain) failed silently** during dependency resolution (npm@11 exited 1 with no
  human-readable ERESOLVE — a peer conflict from the new ESLint-10 / `eslint-seatbelt@0.1.3` stack).
- **`npm install --legacy-peer-deps` succeeded** — added 181 / removed 93 / changed 39 packages;
  `vite-plugin-static-copy` is now **4.1.1** (v4 widened `rename.stripBase` to `number | true`,
  which is what upstream's `scripts/buildSandcastle.js` requires — this was the sole `gulp build`
  type blocker: 5× `TS2322 boolean not assignable to number`).
- `package-lock.json` is part of this merge commit (large diff — the new tooling tree).
- **Build-env follow-up:** the `--legacy-peer-deps` requirement should be revisited — either pin the
  peer-conflicting dep or regenerate the lockfile cleanly so plain `npm ci` works in CI.

## Resolution methodology (owner directive)

> "Take the most modern and best fixes & updates while maintaining functionality."

Per-bucket policy. Every per-file decision was made by a **maximum-effort 3-way diff**
(`:1` base vs `:2` ours vs `:3` upstream), resolving only the genuinely-conflicting regions
and leaving git's auto-merges intact.

| Bucket | Policy |
|---|---|
| **Core/** (math, projections, tiling) | **Take upstream.** Our delta was pure ES6 modernization; upstream converged on the same class form + carries their fixes/JSDoc/TS annotations. Converging keeps future pulls clean. |
| **OURS-WINS** (files we authored/rewrote) | Keep ours; cherry-pick only valuable upstream fixes that don't regress us. |
| **TAKE-UPSTREAM+REHOOK** (upstream-owned Scene files we only hooked) | Take upstream as base; re-apply our WebGPU FeatureRenderer hook / RenderCommand swap / RTE edit on top. |
| **Specs/** | Union — upstream's spec + our added specs. |
| **build / CI / tooling** | Our build customizations (variants, pragma-strip-TS, WASM, side-effects line) win; cherry-pick upstream dep/CI/Node-min bumps. |
| **widgets/** | Case-by-case; union dep bumps. |

---

## Bucket: Core/ — 17 files — TAKE-UPSTREAM (resolved + verified)

Resolved by orchestrator (not the workflow). Method-name set diff (`ours` vs `upstream`)
confirmed **no unique-to-us methods** would be lost before taking upstream.

`AssociativeArray.js`, `BoundingSphere.js`, `Cartographic.js`, `Color.js`, `Credit.js`,
`Ellipsoid.js`, `GeographicProjection.js`, `GeographicTilingScheme.js`, `Iau2006XysData.js`,
`Ion.js`, `JulianDate.js`, `Matrix2.js`, `Matrix3.js`, `Matrix4.js`, `Rectangle.js`,
`WebMercatorProjection.js`, `WebMercatorTilingScheme.js`.

- **Ours kept:** nothing behavioral was at stake — our delta was modernization only.
- **Upstream adopted (regression targets):** 709-commit accumulation of Core math/projection/tiling
  fixes + JSDoc + TS annotations. Co-located `Core/{Matrix4,Cartesian3,Color}.d.ts` still override
  JS inference for TS consumers (unchanged, still valid against upstream's class form).
- **Regression focus:** anything exercising Core math precision — RTE encode paths, projection
  round-trips, tiling-scheme tile extents, `JulianDate` time conversions. The visual-regression
  globe scenes + `npm test` Core specs cover this.

> ⚠️ Note: `Iau2006XysData.js` — upstream keeps prototype form (not class); we'd modernized it to
> class. Taking upstream reverts our modernization here (functionally identical; `preload` +
> `computeXysRadians` API confirmed present). No caller impact.

> ⚠️ **Post-build Core reconciliation (CRITICAL — `take-upstream` was too blunt for Core).** Two
> distinct problems surfaced only at the `gulp build` / engine-tsconfig / runtime layers (the root
> `tsc --noEmit` with `checkJs:false` was blind to both):
>
> 1. **Dropped fork APIs (RUNTIME regression).** Our fork added behavioral statics to Core via
>    `Class.x = function…` *assignments*, which `git checkout --theirs` silently dropped. The
>    Playwright smoke caught it: `TypeError: Matrix4.setDepthRangeType is not a function` in the
>    `Scene` constructor → **both** backends failed to init. An audit (matching `Class.x =` /
>    `Class.prototype.x =` / in-class, not just in-class as the original method-name check did) found
>    fork-only members on 4 Core files. Resolution by **caller count**: **`Matrix4.js` REVERTED to
>    fork** (`setDepthRangeType`/`_depthRangeType`, **11 callers**); `JulianDate` `convertUtcToTai`/
>    `setComponents` (**0 callers** — dead) and `Ellipsoid.initialize` (**0 external callers**) left
>    on upstream; Cartographic's `_ellipsoid*` are runtime caches written by `Ellipsoid.setDefault`,
>    left on upstream.
> 2. **Type-comment calibration.** `Matrix2.js`, `Matrix3.js` — upstream's `@ts-expect-error
>    TODO(tsd-jsdoc)` on numeric `matrix[i]` reads are *unused* under our `.ts`-inclusive engine
>    tsconfig (TS2578) and the reads resolve to `unknown` (TS2322). `git diff -w` confirmed these are
>    **byte-identical to fork modulo comments** → **REVERTED to fork** (zero behavioral delta).
>
> **Final Core state:** 13 files take-upstream; **Ellipsoid** take-upstream + `Cartesian3.d.ts`
> patched with `static _ellipsoidRadiiSquared` (upstream's `Ellipsoid.default` getter is needed by
> 6+ other Core files, so Ellipsoid could NOT be reverted); **Matrix2/Matrix3/Matrix4** kept as fork.
> Lessons: (a) **the engine tsconfig + a runtime smoke are the authoritative gates**, not root
> `tsc --noEmit`; (b) a Core "take-upstream" must diff `Class.x =` statics + check callers, not just
> in-class methods.

---

## Bucket: workflow-resolved (Scene / Renderer / Specs / widgets / build) — 51 files

Resolved by workflow `wg9x392dn` (51 agents, max-effort 3-way diff). **`tsc --noEmit` passed
clean (exit 0)** across the whole resolved tree. 0 conflict markers remain. 9 files were
self-flagged `needsHumanReview` (covered in the follow-ups + per-file notes below).

> **Why the per-file work was non-trivial:** git's auto-merge silently mis-anchored several
> fork edits because our ES6-class conversions reflowed code upstream had also edited. The
> agents caught and corrected **latent runtime ReferenceErrors** that a naive marker-resolve
> would have shipped: `createUniformArray` (fork FloatVec4 fast-path spliced into the IntVec4
> class), `renderBufferPolyline/Polygon/Point` (pick-id locals/destructure dropped),
> `VectorGltf3DTileContent` (`makeDecodeModelOptions`/`_decodeModel` dangling on deleted
> symbols), `scripts/build.js`/`server.js`/`gulpfile.js` (calls to upstream-deleted
> `createGalleryList`/`createJsHintOptions`), `App.tsx` (`highlightLine` on a deleted fn).

---

## ⚠️ Actionable follow-ups (immediate post-merge work)

| # | Item | Status | Action / regression target |
|---|---|---|---|
| 1 | **EDGES_ONLY 3D-Tile direct pass** — upstream's `performCesium3DTileEdgesDirectPass` lived in the Scene.js block we decomposed into `SceneRenderer.js`, so it was unported (the model/command/tileset half came in via conflicts; the scene-execution half didn't). | **PORTED this session** into `SceneRenderer.js` (function + call site after OPAQUE, matching upstream). | Regression-test: `Model`/`Cesium3DTileset` `edgeDisplayMode === EDGES_ONLY` draws edges onto the main framebuffer over opaque surfaces. |
| 2 | **Upstream voxel fixes** to functions our fork extracted into `VoxelPrimitiveHelpers.js` (upstream inlines them in `VoxelPrimitive.js`, so git couldn't map the edits): `metadataOrder` param on `computeInputDimensions`, removal of obsolete `provider.ready`, `setupShapeUniformsAndDefines` changes. | **TRACKED — not yet ported.** Our helpers keep pre-merge behavior (no regression, but misses upstream improvements). | Diff `VoxelPrimitive.js` (base→upstream) for helper-body deltas; apply to `VoxelPrimitiveHelpers.js` + `buildVoxelCustomShader.js`. |
| 4 | **`ModelDrawCommand.js`** — upstream deleted `edgeCommand.uniformMap = uniformMap;` (~L823); git auto-merge kept it. Current code builds a cloned uniformMap with `u_isEdgePass` and assigns it (functionally coherent). | Left as-is (coherent). | Confirm whether upstream re-wired the edge uniformMap elsewhere; if so, drop the kept assignment. |
| 6 | **WebGPU buffer-point parity** — upstream added a `useFloat64` dual-precision position path to the WebGL buffer collections; `BUFFER_WASM_ENCODE_THRESHOLD` must stay in lock-step with the WebGPU buffer-point renderer (CLAUDE.md §5). | **TRACKED.** | Verify WebGPU buffer-point renderer applies the same `useFloat64` gating + threshold. |
| — | **`widgets/package.json`** bumped `@cesium/engine ^24→^26`. | Resolved (union). | Re-run `npm install`; verify widgets resolve against engine v26 API + lockfile updated. |
| — | **`Bucket.tsx`** split-mode `onRunComplete` fires once per iframe (twice in split). | Resolved (grafted onto both frames). | Verify the caller tolerates/dedupes double-fire in split mode. |
| — | **eslint**: `eslint-seatbelt` + `no-useless-assignment` now active on Apps/packages/Specs JS. | Resolved. | May surface new lint on fork WebGPU JS — run `eslint` in gates. |
| — | **Stale Sandcastle generated files** (`Apps/Sandcastle/gallery/gallery-index.js`, `jsHintOptions.js`, `templates/`) no longer regenerated (upstream removed the generators). | eslint still ignores them. | Prune the ignores + files when the legacy Sandcastle1 is removed from the fork. |

---

## Per-file resolutions (regression targets)

Format: **file** — `policy` — *ours kept* / **upstream adopted (regression target)** / risk.

### OURS-WINS / authored (7)

- **`renderBufferPointCollection.js`** — `take-upstream+rehook` *(reviewed)* — Kept: NEW-BUFFERCOLL-WASM-ENCODE (WasmRTEBridge, `BUFFER_WASM_ENCODE_THRESHOLD=2000`, `batchEncodeRange` path, repack instrumentation, debug-pragma timer, rteBridge lifecycle, scalar fallback). **Adopted: Float32/Float64 dual position path (`useFloat64`), attribute-layout change (showSizeColorAlpha→4c, outlineWidthColorAlpha→3c), subpixel-bleed outline fallback, BlendOption pass selection, conditional pickId, pick-id creation relocated to `BufferPrimitiveCollection`, in-place command update, `USE_FLOAT64` shader define, `RenderState.releaseCache`.** Risk: **repointed `batchEncodeRange` at `attributeArrays.positionHigh/.positionLow` (upstream deleted the old locals → would've been a ReferenceError); gated batch encode on `useFloat64`.**
- **`renderBufferPolygonCollection.js`** — `take-upstream` — Kept: RTE high/low encode (in `useFloat64` branch), pick attribute writes + shader pickId binding. **Adopted: in-render pick-id creation removed (relocated to `BufferPrimitiveCollection._updatePickIds`); `useFloat64` guard around RTE encode.** Risk: keeping ours would have thrown ReferenceError; pick-id relocation target verified present.
- **`renderBufferPolylineCollection.js`** — `merged-both` *(reviewed)* — Kept: BufferPolyline pick-id creation block (sole registration site), `pickIds` init + destructure + teardown (auto-merge had dropped → ReferenceError), RTE high/low path. **Adopted: upstream Float32 `_positionView` fast path, separate alpha Uint8Array, `createTypedArray` allocation keyed on `useFloat64`.**
- **`BufferPrimitiveCollection.js`** — `ours-wins+cherrypick` — Kept: `_allocatePositionBuffer` signature + the `.d.ts`-sidecar clean typing (rejected upstream's `@ts-expect-error`, which would be an unused-suppression build error in our fork). No upstream behavioral delta in the regions.
- **`BufferPolygon.js`** — `take-upstream` — Kept: `_dirty` buffer flag (all 3 setters). **Adopted: removed redundant `_makeDirtyBoundingVolume()` in `setHoles`/`setTriangles` (upstream `726e86624c`); retained in `setPositions`.** Regression: editing holes/triangle-indices must not stale the bounding volume.
- **`BufferPoint.js`** — `merged-both` — Both sides had the identical `_dirty=true` fix (#13465); kept our WHY-comment. No semantic shift.
- **`Cesium3DTilePointFeature.js`** — `take-upstream` (31 regions) — No fork delta (our change was an identical ES6-class conversion). **Adopted: upstream's class form + static class fields (defaultColor/PointOutlineColor/Width/Size).** Regression: point-feature defaults still apply when unset.

### RENDERER (4)

- **`Context.js`** — `ours-wins+cherrypick` — Kept: `class Context extends GraphicsContext`, multi-context `_unregisterFromRegistry()` + `_destroyFeatureRenderers()` teardown, inherited pick management. Upstream block was redundant re-stated methods (adopting it would shadow class methods + drop fork teardown).
- **`DrawCommand.js`** — `take-upstream+rehook` (5 regions) — Kept: 6 fork fields (sortKey/sortLayer/sortPriority/materialSortId/visibilityMask/isTransmissive) in ctor + shallowClone, `@internal` derivedCommands doc. **Adopted: `@ts-check`, typed `@import`s, `DrawCommandOptions` typedef, default-param ctor, module-scope hasFlag/setFlag.**
- **`PickId.js`** — `union` (add/add) — Kept: WebGPU `normalizedRgba`, `_pickKinds` map + cleanup, dual-encoding JSDoc. **Adopted: `@ts-check`, `@implements {Destroyable}`, typed fields.** (tsc passed.)
- **`createUniformArray.js`** — `take-upstream+rehook` *(reviewed)* — Kept: FloatVec4 pre-packed Float32Array fast-path (czm_lightsData) + enhanced error. **Adopted: full ES6-class conversion, `@ts-check`, `@ts-expect-error #13302`, clean IntVec4.set.** Risk: **auto-merge had spliced the fork FloatVec4 fast-path into the IntVec4 class — relocated to FloatVec4 + clean upstream IntVec4.** Regression: czm_lightsData / packed-vec4 uniforms render on WebGL without throwing.

### TAKE-UPSTREAM (+ rehook) — Scene / Model (28)

- **`Scene.js`** — `take-upstream+rehook` *(reviewed)* — Kept: full decomposition architecture (SceneRenderer/ViewportExecutor/SceneUtilities/SceneDebug/FramebufferOrchestrator imports), WebGPU per-view hook, V-A3 atmosphere lighting. **Upstream delta = the EDGES_ONLY direct pass → ported into `SceneRenderer.js` (follow-up #1).**
- **`QuadtreePrimitive.js`** / **`QuadtreeOccluders.js`** / **`QuadtreeTile.js`** — `take-upstream` — All ES6-convergent; position-cache feature intact (QuadtreeTile). **Adopted: aliasing-prevention comment (QuadtreePrimitive), ctor JSDoc (Occluders), LRUCache `size` getter + `@ts-check` (QuadtreeTile).** QuadtreeTile auto-merge had **duplicated methods** — clean upstream blob removed the duplication.
- **`Cesium3DTileFeature.js`** — `take-upstream` (11 regions) — **Adopted: `getPropertyInherited` now a real static + gained a 4th `batchTable` override param (default preserves behavior — regression-test explicit-batchTable callers).**
- **`Cesium3DTileset.js`** — `ours-wins+cherrypick` — Kept: `_invalidationFeed` live-invalidation (12 refs), fork debug fields. **Adopted/grafted: `edgeDisplayMode` field, `_runtimeContentCodec` field.**
- **`Multiple/Composite/Tileset/Implicit/GaussianSplat/Vector/VectorGltf/Geometry/Empty3DTileContent.js`** + **`Model3DTileContent.js`** — `take-upstream` — All convergent ES6 conversions; auto-merge had duplicated methods, resolved to clean upstream layout. Notables: **`Model3DTileContent` adopts `model.edgeDisplayMode = tileset.edgeDisplayMode` each frame; `VectorGltf` adopts the full feature-table support (getFeature/hasProperty/applyStyle now functional vs stubbed); `Composite/Tileset/Implicit` factory methods now in-class statics — verify content-type dispatch still resolves.`**
- **`VoxelPrimitive.js`** — `ours-wins+cherrypick` *(reviewed)* — Kept: decomposed helper imports, WebGPU `VOXEL_PRIMITIVE` FeatureRenderer hook, lazy provider init. **Adopted: DefaultCustomShader normal-based diffuse lighting (default voxel render now shaded, not flat white).** Risk → **follow-up #2 (helper-body upstream fixes).**
- **`VoxelEllipsoidShape.js`** / **`VoxelCylinderShape.js`** / **`VoxelBoxShape.js`** — `take-upstream(+rehook)` — **Adopted: UV-transform refactor — per-axis scale packed into a single `*LocalToShapeUvScale` Cartesian3 + JS-only `_localToShapeUvTranslate`, replacing the old per-component uniforms; div-by-zero guards.** Risk: **auto-merge applied the UV refactor inconsistently across ctor/update/convert — manually re-synced all 3 sites (GLSL shader consumes the new vec3 uniform).** Regression: voxel ellipsoid/cylinder/box rendering + picking.
- **`Model.js`** — `take-upstream+rehook` — Kept: ES6 class, WebGPU `MODEL` FeatureRenderer hook, fork accessors. **Adopted/grafted: `edgeDisplayMode` (EXT_mesh_primitive_edge_visibility), defaults SURFACES_ONLY.**
- **`pickModel.js`** — `take-upstream` — **Adopted: full delegation to new `ModelReader` (supersedes fork #13433 instance-order + octDecode fixes — equivalent behavior). Dependency: `ModelReader.js` (new upstream file, present from merge).**
- **`ModelReader.js`** — `take-upstream+rehook` — Kept: #13433 octDecode WHY-comment. **Adopted: octDecode arg-order fix (now identical both sides), forEachPrimitive traversal, instance-transform helpers, typed-array fast path.**
- **`ModelRuntimePrimitive.js`** — `ours-wins+cherrypick` — **Adopted: `hasImageryLayers` requires `length > 0` (empty array no longer runs ImageryPipelineStage)** (ours already had the identical guard).
- **`ModelDrawCommand.js`** — `take-upstream+rehook` *(reviewed)* — Kept: ES6 class, edge-command infra. **Adopted: EDGES_ONLY surface-skip + dynamic edge-pass selection (`CESIUM_3D_TILE_EDGES_DIRECT` vs `CESIUM_3D_TILE_EDGES`).** Risk → **follow-up #4 (uniformMap).**
- **`InstancingPipelineStage.js`** — `merged-both` — Comment-only conflict; `keepTypedArray`-forces-matrix (#13433 picking fix) identical both sides.
- **`EdgeVisibilityPipelineStage.js`** — `take-upstream+rehook` *(reviewed)* — Kept: `EdgeVisibilityType` enum, WebGPU `requiresVertexTypedArrayRetention` capability guard. **Adopted: upstream silhouette-normal scheme (from GLB accessor) exclusively; dropped fork CPU triangle-adjacency fallback (`buildTriangleAdjacency` orphaned → removed).** Risk: models without GLB silhouetteNormals now early-return (no fork adjacency synthesis).
- **`createVectorTileBuffersFromModelComponents.js`** — `take-upstream` — **Adopted: whole-file v1.142 rewrite (feature-factory; points now use the same pickObject/featureId path as polylines/polygons).**
- **`EquirectangularPanorama.js`** / **`CameraEventAggregator.js`** — `take-upstream`/`merged-both` — Panorama: indentation-only conflict, material/cull flags intact. **CameraEventAggregator adopts combined keyboard-modifier support (SHIFT+CTRL etc.).**

### SPECS (2)

- **`BufferPointCollectionSpec.js`** — `union` — Kept fork #13465 dirty-tracking test. **Adopted: upstream boundingVolume-static + positionNormalized tests.** (Test reads private `_dirty/_dirtyOffset/_dirtyCount` — depends on internals surviving merge.)
- **`pickModelSpec.js`** — `merged-both` — Kept `webglStub` skip guard. **Adopted: setView-based instanced-pick test + center-miss assertion + corrected expected hit.**

### BUILD / WIDGETS (8)

- **`scripts/build.js`** — `merged-both` *(reviewed)* — Kept: `development`/`useSplitting` code-splitting, `BundleVariant` variant wiring, `skipSharedAssets` guard, `createCesiumJs(variant)` entry-barrels. **Adopted: removed `createGalleryList`/`createJsHintOptions` calls (upstream deleted the fns + `child_process` import → keeping would ReferenceError).**
- **`server.js`** — `take-upstream+rehook` — Kept: `isWatchedSource` (.js+.ts hot-reload), WGSL shader watcher, `sandcastlePort`. **Adopted: dropped orphaned `jsHintOptionsCache`.**
- **`gulpfile.js`** — `merged-both` — Kept: `copyVariantSharedAssets`, `wgslToJavaScript`. **Adopted: dropped `createJsHintOptions` import.** (Cross-dep: build.js still exports `wgslToJavaScript` + `copyVariantSharedAssets` — verified.)
- **`eslint.config.js`** — `ours-wins+cherrypick` — Kept: WebGPUTest + WASM + stale-Sandcastle ignores. **Adopted: `eslint-seatbelt` integration + `no-useless-assignment` (needs `eslint.seatbelt.tsv` present).**
- **`packages/sandcastle/src/App.tsx`** — `merged-both` — Kept: `rendererMode`/`showFps` Bucket props. **Adopted: `highlightLine` inline no-op (upstream deleted the standalone fn), copilot/ChatPanel/onRunComplete wiring.**
- **`packages/sandcastle/src/Bucket.tsx`** — `merged-both` *(reviewed)* — Kept: split-screen WebGL-vs-WebGPU, BucketFrame refactor, renderer/showFps/label threading. **Adopted: `onRunComplete` (grafted onto both split frames → follow-up double-fire note).**
- **`packages/widgets/Source/Viewer/Viewer.js`** — `ours-wins+cherrypick` — Kept: ES6-class form of the 12 trailing methods. **Adopted: `BufferPrimitiveCollection` JSDoc on zoomTo/flyTo (doc-only).**
- **`packages/widgets/package.json`** — `union` — Kept: `dompurify ^3.3.0`. **Adopted: `@cesium/engine ^26.0.0`, `engines.node >=22`.**

---

## Post-merge green-ing fixes (verification targets)

Fixes applied AFTER conflict resolution to bring the merge into the green (build/tsc/lint). Tags: *authored* (fork-new), *took-upstream* (restored upstream code), *hybrid* (grafted).

- **Engine-tsc 48→0** *(authored — typing)* — The engine tsconfig (`tsc --project packages/engine/tsconfig.json`, `checkJs:true`) surfaced 48 errors the root `tsc --noEmit` (`checkJs:false`) missed. Fixed via: Matrix2/3 getter index-read casts (`const x = /** @type {number} */ (matrix[i])`), `Cartesian3.d.ts` `static _ellipsoidRadiiSquared`, double-casts-through-`unknown` at WIP-bridge sites (DrawCommand, createUniformArray), `Cesium3DTileset` 4 methods `@private`→`@internal`. **Regression:** `npx gulp build` (runs engine tsc) must stay clean — root tsc is NOT sufficient.
- **Matrix4 depth-range graft** *(hybrid)* — Core take-upstream dropped the fork's `Matrix4._depthRangeType` + `Matrix4.setDepthRangeType` (defined via `Class.x = fn`, not in-class, so the in-class safety check missed them → runtime `setDepthRangeType is not a function` crash). Re-grafted onto upstream's ES6 Matrix4: 4 projection methods got `if (Matrix4._depthRangeType === "webgpu") {…} else {<upstream>}` depth branches + the static + setter after the class. **Regression:** WebGPU [0,1] clip depth — verified webgpu-range at runtime (projection col3row2=−0.1).
- **Restored 11 upstream-code lint deletions** *(took-upstream — CRITICAL, owner-caught)* — `no-useless-assignment`/`no-unassigned-vars` flagged genuine upstream code (`maxSpan=zSpan` ×3 BoundingSphere; `--index`/`byteOffset+=`/`glbByteOffset+=` in JulianDate/Vector3DTileContent/Cesium3DTilesTerrainDataSpec). Initially deleted to satisfy lint; owner caught it (deleting Vector3DTileContent's `byteOffset+=` orphaned `pointsPositionByteLength`). ALL restored via `git checkout upstream/main --`; upstream keeps them + grandfathers in `eslint.seatbelt.tsv`. Only legit removal: `Context.js` unused `PickId` import (dead in the GraphicsContext architecture).
- **eslint-seatbelt cross-platform (posix)** *(authored — tooling)* — seatbelt keys violations by OS-native separator (`path.relative`), so a Unix `.tsv` mismatches Windows backslash lookups (and vice-versa). Fixed by posix-normalizing `toRelativePath` in both seatbelt chunks (CJS `chunk-K7UHJBLM.js` + ESM `chunk-OKIIDZIF.mjs`), persisted idempotently by `scripts/patchEslintSeatbelt.mjs` (postinstall — patch-package needs a lockfile this fork lacks). `eslint.seatbelt.tsv` re-baselined to 137 posix entries (0 backslash). Toolchain reconciled: `@eslint/js ^10`, `eslint-config-prettier ^10`, `eslint-plugin-n ^17`, `eslint-plugin-html ^8.1.4` (8.1.3 crashed on eslint-10). **Regression:** whole-repo `eslint` exit 0 on BOTH Windows + Linux.
- **SceneRenderer edges-direct pass** *(took-upstream — follow-up #1)* — ported `performCesium3DTileEdgesDirectPass` into `SceneRenderer.js` (the WebGL path). **NOTE:** the §5 audit found the **WebGPU** frustum loop does NOT yet wire `CESIUM_3D_TILE_EDGES_DIRECT` (slot 12) — WebGPU EDGES_ONLY parity is a P2 follow-up (see `WEBGPU_PARITY_AUDIT_2026-06.md`).

## "Globe-black" investigation — RESOLVED as a probe artifact (NOT a merge regression)

During verification the WebGPU default-`CesiumViewer` globe appeared black. After an extensive hunt (incl. a pre-merge worktree bisect — *every* commit built black), the root cause was a **probe artifact**: `CesiumViewer?renderer=webgpu` defaults to `scene.requestRenderMode = true`, under which `Scene.render()` is a no-op unless a render is requested — so the probe's manual render loop never painted. The canonical gate `probe-globe-bindgroup-cache.mjs` (sets `requestRenderMode=false` + waits for pipeline materialization, not just `tilesLoaded`) **PASSES on the merge** (nonBlack 30.9%, 349 color buckets); the same default-viewer probe with the fix renders at 23.7% (screenshot confirmed). **The merge never broke the globe — there was no globe regression.** A real latent bug was surfaced en route (clustered-lighting render-pass leak, disabled-by-default) and tracked separately. Full write-up + the load-bearing probe rule: `WEBGPU_DEBUGGING_LOG.md` (2026-06-17 entry).

## Enum-renumber guard (merge-hazard prevention)

Upstream merges can silently renumber enum VALUES that fork code — especially WGSL shaders, which can't `import` a JS enum and must **hardcode** the numbers — depends on. This merge renumbered `Pass.js` (`OVERLAY 12→13`, `NUMBER_OF_PASSES 13→14`, new `CESIUM_3D_TILE_EDGES_DIRECT:12`); `TerrainQuantization` did NOT renumber (modernization-only). **Recommended guard (TODO):** a Jasmine spec pinning the WebGPU-consumed enum values — `Pass.GLOBE===2`, `Pass.OPAQUE===8`, `TerrainQuantization.NONE===0`/`BITS12===1`, the `ShaderDefine` bits — so a future merge that renumbers any of them fails CI loudly instead of silently breaking a WGSL hardcode. CLAUDE.md already mandates "add-only, never renumber" for `ShaderDefine`/`ShaderSourceId`; this guard extends the protection to upstream-owned enums and adds an enforcing test.

## Post-merge WebGPU-integration backlog (§5)

The post-merge parity audit (new upstream v1.141–1.143 features vs WebGPU support) lives in **`WEBGPU_PARITY_AUDIT_2026-06.md`** — 15 real gaps, **0 P0**. Headline: the `BufferPrimitive` family (`color.alpha`/`blendOption`/world-space `boundingVolume`, P1, best as one coordinated batch), `EdgeDisplayMode` tri-mode incl. wiring the WebGPU `CESIUM_3D_TILE_EDGES_DIRECT` pass (P2), the voxel data path (XL scaffold). All deferred follow-ups — NOT merge blockers. To be reconciled into `FEATURE_INVENTORY.md` §C/§D + `DEFERRED_WORK.md`.
