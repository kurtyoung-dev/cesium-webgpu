# DEV notes — voxel and splat rendering

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `maybeSortSplats`

_Moved 2026-08-21._

> NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288). CPU back-to-front sort of the
> splat indices by view-space depth, uploaded to the sorted-index storage
> buffer the VS reads via `sortedIndices[instance_index]`. Without this the
> WebGPU draw visited splats in buffer order, producing order-dependent
> premultiplied over-blend errors (audit A2.1). Runs only when the camera has
> rotated enough since the last sort (cheap-frame amortization). The sort key
> is the splat-center eye-space z; farthest (most negative z) drawn first.
>
> # `C15-G4` — why this is RETIRED but not deleted
>
> It is a synchronous main-thread `Array.prototype.sort` with a JS comparator
> over a freshly allocated `Float64Array(count)`. On production content that is
> a per-frame stall — `tower` is 286,868 splats — so `C15-G4` retires it from
> that path STRUCTURALLY: the packed layout returns before any work, and
> `uploadProvidedSortOrder` has already consumed the worker's permutation by
> the time this is called at all.
>
> It is NOT dead code (Principle 7). The LEGACY 16-f32 record has exactly three
> exercisers, all synthetic probe primitives that carry `_splatData` and no
> `_indexes` — `probe-splat-sort.mjs` (which asserts the non-identity
> permutation and is the Batch-288 sort-consume evidence),
> `probe-splat-globe-occlusion.mjs` and `probe-oit-transparency.mjs`. Deleting
> this would leave those three drawing in identity order and turn a green
> instrument red for a reason that has nothing to do with what it measures.
>
> @private

Kept because the apparently redundant comparator is deliberate scaffolding
for synthetic primitives and must not be removed while those inputs exist.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `computeLocalSplatBoundingSphere`

_Moved 2026-08-21._

> C15-G6h (NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE) — MODEL-space bounding sphere
> over the resident splat centres.
>
> # Why the command needs one at all
>
> `View.createPotentiallyVisibleSet` gives a command with NO `boundingVolume`
> the camera's worst-case span (`View.js:382-392`). Under log depth that span
> is `[0.1, 1e10]`, whose 1e11 ratio splits into TWO depth slices — and the
> BV-less command then bins into BOTH, while the globe (whose tiles carry real
> bounding volumes) bins only into the near one. The frustum loop clears depth
> between slices (`WebGPUSceneRendererFrustumLoop.ts:251-253`) and preserves
> colour, so the splat's far-slice execution draws against a depth buffer that
> does not contain the globe. That is the `C15-G6h` leak: measured at Batch 888
> with all three producers' baked log-depth pairs EQUAL, which excluded the
> encode and left the binning.
>
> B647 already added `boundingVolume: tileset.boundingSphere` for real content
> (matching `GaussianSplatPrimitive.js:2318`), but every exerciser of this path
> is a synthetic primitive with no `_tileset`, so that fix has never executed —
> the `C15-G6` queue row records exactly that. This derivation closes the gap
> for ANY producer, so a custom or synthetic primitive cannot silently inherit
> the worst-case span.
>
> # Cost
>
> Called ONLY from the attribute-commit block, which already walks the same
> bytes to upload them and already fills an O(n) identity permutation. Two
> allocation-free passes (AABB, then exact radius about its centre) add no new
> asymptotic cost and nothing per frame — the per-frame work is one
> `BoundingSphere.transform` at the command site.
>
> # What is deliberately NOT included
>
> The Gaussian FOOTPRINT (each splat's covariance) is not added to the radius.
> The command is not `cull`-gated — `Scene.isVisible` returns true immediately
> for `!command.cull` (`Scene.js:3746`) — so this volume can never clip a splat
> out of the frame; it feeds slice binning, the scene near/far accumulators and
> the back-to-front sort key, all of which work in kilometres-to-megametres
> while a splat's footprint is metres. Adding it would mean decoding f16
> covariance for the packed layout to move a slice boundary that cannot move.
>
> @param view - the resident attribute bytes (legacy 16-f32 or packed 8-u32).
> @param count - splat count.
> @param packed - true for the WASM `SPLAT_PACKED_WASM` record layout.
> @returns the model-space sphere, or null when there is nothing to bound.

Kept because it records both the multi-frustum failure mechanism and why the
derived bound intentionally omits covariance.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `updateWebGPUGaussianSplats`

_Moved 2026-08-21._

> (Re)build the group-0 bind group whenever it's missing (init, format/
> log-depth flip, or a storage-buffer reallocation cleared it).
> ── C15-G3 — commit the attribute bytes.
>
> The dirty signal is (count, layout, producer identity), not the count
> alone: a snapshot rebuild that lands on the SAME splat count produces a
> fresh payload object and nothing else changes, and re-uploading only on a
> count change would leave the previous cloud resident forever.
>
> C15-G3b — this block sits ABOVE the pipeline gate deliberately. Uploading
> the attribute bytes needs the DEVICE, not a pipeline, and
> `tryResolveSplatPipelines` legitimately returns early for however long a
> cold variant takes to compile (~2.7 s measured on this fork). With the
> commit below that gate, `cache.splatCount` stayed 0 for the whole compile
> even though the data had been ready since the shared pipeline committed it
> — which is exactly what the Batch-881 Edge run measured (`splatCount=0`
> sampled during readiness, 27 by the time the scored frame drew). Hoisting
> it makes the count mean "the data is resident", not "the data is resident
> AND a pipeline happened to finish compiling", and it starts the upload one
> compile earlier. The command build still waits on the pipeline below.

Kept because it explains why moving uploads below the pipeline gate would make
resident state lie during cold-pipeline frames.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `GaussianSplatCache.resourcesLayoutPacked`

_Moved 2026-08-21._

> The layout the PIPELINE RESOURCES were compiled for. Tracked separately
> from `layoutPacked` (which describes the resident BUFFER) because the two
> are legitimately out of step for the frames between a layout flip and the
> pipeline resolving: `tryResolveSplatPipelines` returns early while a cold
> variant compiles (~2.7 s measured on this fork), and the buffer commit sits
> BELOW that return. Comparing the flip against the buffer's layout would
> therefore re-invalidate — and re-request — the pipelines on every frame of
> that window.

Kept because the two layout fields look redundant once compilation finishes,
but they represent different states during the asynchronous window.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `buildSplatPipelineResources`

_Moved 2026-08-21._

> Store shader code for dynamic OIT variant creation via scene renderer
> (`WebGPUSceneRendererTranslucentPass` builds an OIT pipeline from it when
> `_oitPipeline` is absent).
>
> C15-G3 — PREPROCESSED, not raw. The raw template still carries the
> `//>>ifdef` directives, which WGSL sees as comments: the consumer would
> compile a source with BOTH branches of every block present (two
> `fragmentMain` definitions) and, on the splat shader specifically, with
> the wrong record stride for packed data.
>
> NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — both halves now come from the
> pipeline resources rather than being re-derived here. Two defects the
> re-derivation carried: (1) it rebuilt the define mask from
> `cache.layoutPacked` alone, so after `C15-G5` it omitted
> `SPLAT_SPHERICAL_HARMONICS` while the renderer's OWN OIT module included
> it — a fallback pipeline would have composited the base colour while the
> colour pass composited the view-dependent one; and (2) no
> `_pipelineConfig` was published at all, so the fallback substituted
> `layout: "auto"` and the command's explicit-layout bind groups would
> have failed WebGPU validation. Publishing them as a pair from one build
> is what keeps the shader axes and the layout from drifting apart again.

Kept because partial fallback reconstruction can produce a layout mismatch or
the wrong shader variant even though either resource looks valid alone.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `updateWebGPUGaussianSplats`

_Moved 2026-08-21._

> C15-G6g — publish WHAT THIS PRODUCER ACTUALLY BAKED, at the moment it
> baked it. The whole family has been argued from the fields each producer
> READS (verified identical in source at `C15-G3d`) and from a post-render
> sample of `uniformState` (which is the LAST FRUSTUM SLICE, not what anyone
> packed). Neither is the quantity that decides the depth compare. This is.

Kept because a plausible reuse of the post-render snapshot silently assigns
the wrong logarithmic depth parameters to earlier slices.

### `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — `updateWebGPUGaussianSplats`

_Moved 2026-08-21._

> C15-G5 — spherical-harmonics tail at byte offset 320 (float 80).
>
> The GLSL evaluates SH against
>   normalize(u_inverseModelRotation * (splatWC - cameraWC))
> where `u_inverseModelRotation` is the rotation of
>   inverse(tile.computedTransform × axisCorrection × content.worldTransform)
> — the SH training frame — cached by the primitive as `_shInverseRotation`
> on every snapshot rebuild (GaussianSplatPrimitive.js:1536-1552).
>
> The WGSL has no world-space splat position; it has `posRTE`, the
> camera->splat vector in the primitive's MODEL frame. For a model matrix
> M = [A | t] and a camera encoded in model space (c_model = M^-1 c_world),
>   A * posRTE = A*p - A*M^-1*c_world = (A*p + t) - c_world = splatWC - c_world
> EXACTLY, for any invertible A — the translation cancels in the difference.
> So folding the two rotations CPU-side into one mat3 reproduces the GLSL's
> argument with no extra shader work and no world-space round trip.

Kept because it records the coordinate-frame identity behind the compact CPU
rotation path.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelDataUpload.ts` — `VoxelDataUploadState`

_Moved 2026-08-21._

> WebGPU Voxel Data Upload — PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1)
>
> Replaces the 4×4×4 gradient placeholder in {@link WebGPUVoxelRenderer} with
> the REAL per-tile voxel property data for the ROOT (single) voxel tile.
>
> Scope (deliberately narrow — one clean increment):
>   - ROOT tile only (tileLevel/x/y/z = 0). No octree traversal, no LOD, no
>     multi-tile megatexture atlas. Direct uvw→texel sampling: the ray-march
>     cube maps 1:1 to the tile's `dimensions` grid.
>   - Single metadata property (the first channel-4 / VEC4 property). The test
>     asset (VoxelBox3DTiles) has exactly one VEC4 FLOAT32 property `a`.
>
> VOXEL-OCTREE-LOD (increment: depth-1 octree traversal) — when the provider
> advertises `availableLevels >= 2` and the shape is a BOX (the sampling
> convention now also covers ELLIPSOID — NEW-VOXEL-ELLIPSOID-SHAPEUV — and
> CYLINDER — NEW-VOXEL-CYLINDER-SHAPEUV — but multi-level atlases stay
> box-gated), the destination texture is allocated
> as a 9-slot 3D ATLAS stacked
> along Z: slot 0 = root tile, slots 1..8 = the eight level-1 child tiles
> (childIndex = x + 2y + 4z in the Z-up shape frame). Child tiles are
> requested + uploaded asynchronously after the root; a child that is
> unavailable / fails keeps `childSlots[i] = -1` and the WGSL march falls back
> to sampling the ROOT for that octant — the same semantics as Octree.glsl's
> OCTREE_FLAG_PACKED_LEAF_FROM_PARENT leaf, specialised to depth 1.
>
> NEW-VOXEL-OCTREE-DEEP-TRAVERSAL (increment: depth-2) — when the provider
> advertises `availableLevels >= 3` (and the 73-slot atlas fits the device's
> `maxTextureDimension3D`), the atlas grows to 73 slots: slot 0 = root,
> 1..8 = level-1 children, 9..72 = the 64 level-2 tiles in linear order
> `x + 4y + 16z` (the radix-2 extension of the level-1 octant convention,
> Z-up shape frame). Level-2 tiles upload asynchronously alongside the
> level-1 set; an unavailable level-2 tile keeps `l2Slots[i] = -1` and the
> WGSL walk stops at the deepest uploaded ancestor for that region.
>
> NEW-VOXEL-STREAMING-UPLOAD (increment: demand-driven upload) — descendant
> tiles are no longer uploaded eagerly the moment the root lands. Each frame
> the renderer evaluates the camera's SSE refinement ladder UNCAPPED by what
> is uploaded (capped only by the atlas capacity) and passes the resulting
> DEMAND level into {@link tryUploadChildVoxelTiles}: level-1 tiles are
> requested/uploaded only while the camera demands level >= 1, level-2 tiles
> only while it demands level >= 2 — mirroring upstream VoxelTraversal, which
> only adds a tile to the megatexture when the SSE test visits it. A far
> camera therefore keeps a root-only atlas; zooming in streams descendants in
> on demand. Scenes whose camera demands the deepest level converge to the
> SAME fully-uploaded steady state as the historical eager path
> (pixel-identical steady state — the off-gate).
>
> NEW-VOXEL-ATLAS-LRU-EVICT (increment: LRU slot eviction) — when the
> level-2 tile set does NOT fit the atlas (the device's
> `maxTextureDimension3D` caps the slot count below 73, or the opt-in
> per-primitive `_webgpuVoxelAtlasMaxSlots` override does), the level-2
> region of the atlas becomes a DYNAMIC slot pool (slots 9..slotCount-1)
> with LRU eviction — the upstream VoxelTraversal megatexture add/remove
> analogue. Residency follows per-tile demand (the renderer's
> `computeVoxelL2DemandMask`: per-tile SSE + frustum visibility): a demanded
> tile that is ready to upload takes a free slot, or evicts the
> least-recently-demanded resident that is NOT demanded this frame; if every
> resident is currently demanded the upload simply waits (no overflow, no
> thrash). An evicted tile resets to `idle` and re-requests/re-uploads the
> next time the camera demands it. Root (slot 0) and the eight level-1 tiles
> (slots 1..8) keep their static assignments and are never evicted.
> Under-capacity scenes (the full 73-slot atlas fits and no override is set)
> take the exact static B19 path — byte-identical (the off-gate).
>
> NEW-VOXEL-OCTREE-DEEP-LEVELS (increment: depth-3) — when the provider
> advertises `availableLevels >= 4` AND the full 585-slot atlas fits the
> device (`slotCap >= 585`), the atlas grows to 585 slots: 0 = root, 1..8 =
> level 1, 9..72 = level 2, 73..584 = the 512 level-3 tiles in linear order
> `x + 8y + 64z` (the radix-2 extension of the level-2 convention). Level-3
> tiles upload demand-driven alongside the shallower sets (the same
> level-generic `driveTileLevelUploads` machine, edge = 8), and the WGSL walk
> (`octreeDescend`) descends to level 3 reading `l3Slots`. This is the STATIC
> full-atlas path only — the dynamic LRU pool is NOT yet generalized to level
> 3, so providers whose level-3 set does not fit the device fall back to the
> level-2 cap exactly as before (off-gate preserved).
>
> What is NOT done here (honest partial — separate increments):
>   - Octree traversal DEEPER than level 3, and a DYNAMIC (LRU) level-3 pool
>     for level-3 sets that do not fit the device (a deeper/partial walk would
>     reuse this increment's LRU pool with a per-level page table instead of
>     the fixed l2Slots/l3Slots arrays).
>   - LOD refinement for non-BOX shapes (cylinder/ellipsoid stay root-only).
>   - Non-VEC4 properties (VEC3/VEC2/scalar) — this increment uploads the first
>     property expanded to RGBA. Missing channels default to 0, alpha to 1.
>   (Per-cell pickVoxel against refined tiles shipped in
>   NEW-VOXEL-PICK-OCTREE-COMPOSE — the pick march composes the same depth-1
>   traversal and emits the child slot as the megatexture index.)
>
> Off-gate: this module is only invoked when a real voxel provider + tile
> content is available. When no provider/data is present the caller keeps the
> placeholder gradient path (byte-identical off-case). The ray-march WGSL is
> unchanged — it still samples a `texture_3d<f32>`; only the SOURCE of that
> texture changes (placeholder → real data).
>
> @module WebGPUVoxelDataUpload

Kept because the otherwise similar per-level arrays are intentional
scaffolding for different residency models.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelCustomShaderCodegen.ts` — `generateVoxelUserShaderChunk`

_Moved 2026-08-21._

> Non-zero fingerprint for the DP-H46b generated-source identity and the
> pipeline-cache name. Keep remapping the former Batch 476 reserved value
> as well so persisted diagnostics retain stable hash behavior across the
> cache-key widening.

Kept because removing either remap can create an identity collision that is
not apparent from the generated WGSL alone.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` — `updateWebGPUVoxelPrimitive`

_Moved 2026-08-21._

> Batch 173 - UBO grew 256 → 320 bytes to include the model matrix
> (floats 56-71 at byte offset 224). VOXEL-SHAPEUV-CONVENTION grew it
> 320 → 432 bytes for the WebGL sample-frame fields (floats 76-107:
> dimensions + Y-up flag, proxy→shapeUv matrix, inputDimensions,
> paddingBefore, proxy-space camera) consumed by the real-data
> color-parity march. VOXEL-OCTREE-LOD grew it 432 → 480 bytes for the
> depth-1 octree fields (floats 108-119: per-child atlas slots + slot
> count + target LOD level). NEW-VOXEL-OCTREE-DEEP-TRAVERSAL grew it
> 480 → 736 bytes for the 64 level-2 atlas slots (floats 120-183) read by
> the iterative octree walk. NEW-VOXEL-ELLIPSOID-INTERSECT grew it
> 736 → 832 bytes for the shape-typed intersection fields (floats
> 184-207: proxyToLocal + ellipsoidRadii/shapeType + heightMinMax).
> NEW-VOXEL-ELLIPSOID-SHAPEUV grew it 832 → 864 bytes for the ellipsoid
> lon/lat/height shapeUv mapping terms (floats 208-215).
> NEW-VOXEL-CYLINDER-SHAPEUV grew it 864 → 912 bytes for the cylinder
> radius/angle/height terms (floats 216-227). NEW-VOXEL-OCTREE-DEEP-LEVELS
> grew it 912 -> 2960 bytes for the 512 level-3 atlas slots (floats
> 228-739) read by the iterative octree walk when it descends to level 3.

Kept because the final size and range boundaries are useful when changing the
packing, while the step-by-step growth history is not.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` — `updateWebGPUVoxelPrimitive`

_Moved 2026-08-21._

> NEW-PICK-METADATA-READBACK (Batch 285) — the color pipeline draws into the
> MSAA scene framebuffer, so it MUST bake `multisample.count =
> context._msaaSamples` like every other scene-FB renderer
> (WebGPUEllipsoidPrimitiveRenderer / BufferPoint / Cloud / ComputeInstance,
> etc.). It was previously left at the default count:1, so on any MSAA scene
> (the default msaaSamples is 4) WebGPU dropped every voxel color draw with
> "Attachment state of [Voxel color pipeline] is not compatible with [Scene
> Framebuffer Render Pass]" — the voxel never rendered, so pickVoxel had no
> pixel to read back. Pick + velocity stay single-sample (pick FBO and the
> velocity target are single-sample). The cache invalidates on sample-count
> change as well as format change so a mid-session msaaSamples toggle
> rebuilds the descriptor.

Kept because the different sample-count policies are intentional consequences
of attachment compatibility, not an opportunity to make all variants match.

### `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` — `resolveVoxelUserShaderInfo`

_Moved 2026-08-21._

> VOXEL-USER-CUSTOMSHADER — resolve (and cache, keyed by customShader object
> identity) the generated user-WGSL chunk for this primitive's customShader.
> Returns `null` when the primitive should keep the DEFAULT gray parity path:
> no customShader / the DefaultCustomShader, a GLSL-only customShader
> (warn + default — the model renderer's PARITY-CUSTOM-SHADER-WGSL policy),
> or a WGSL customShader with uniforms (warn + default — voxel customShader
> uniforms/textures are a documented follow-up).
> @private

Kept because both fallbacks are deliberate scaffolding that prevents generated
shaders from referring to unavailable bindings or translation output.
