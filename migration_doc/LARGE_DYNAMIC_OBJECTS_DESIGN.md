<!-- Roadmap synthesized by the large-dynamic-objects-roadmap-scope workflow (6 agents, 2026-06-11).
     Grounded in fork code via read-only scoping. Owner-directed: pick architecture by update regime.
     Step 0 (dirty-consume) shipped for billboards (b4a9e58fd9) + labels (7e24700f8a). -->

# Large Dynamic Objects on WebGPU — Phased Implementation Roadmap

**Owner:** lead architect · **Date:** 2026-06-11 · **Fork:** `f:/Dev/GH/cesium-webgpu`
**Status of Step 0:** dirty-consume DONE for billboards (`BillboardCollection._consumeDirtyState()`, `BillboardCollection.js:632-648`; call site `WebGPUBillboardRenderer.js:1258`).

---

## 1. Executive Summary

The owner's thesis is that there is no single "large dynamic objects" architecture — there are **four update regimes**, each with a distinct cost model, and the right move is to pick the data path by regime rather than build one over-general system. This roadmap turns that thesis into a build order.

The headline finding from scoping: **most of the substrate already exists in-tree.** The WebGPU compute engine, storage-buffer pool, SoA `Buffer*` collections, the WASM RTE-encode kernel + bridge, and a complete compute-sim→instanced-draw precedent (weather particles) are all shipped. The work is overwhelmingly *connective and domain-specific* (SGP4 math, slot-mapping logic, wiring dead kernels into hot paths), not greenfield plumbing. The two genuinely greenfield pieces are the **SGP4 propagator** (Phase 3) and the **ECS framework** (Phase 4) — and Phase 4 is very likely unnecessary.

### Regime → Architecture decision table

| # | Update regime | Cardinality | Architecture | Backend story | Phase |
|---|---|---|---|---|---|
| 1 | **Static / sparse** — few of many objects change per frame | up to ~50k, ~tens changed/frame | Resident CPU instance array + **per-instance partial `writeBuffer`** (`writeBuffer(buf, slot*stride, …, stride)`), O(changed) | Same path both backends; WebGPU primary | **Phase 1** |
| 2 | **Dense / arbitrary** — many objects, positions set externally, not derivable | 10k–100k, bulk re-set/frame | **Flat SoA `Buffer*` collections + WASM encode kernel** (RTE high/low), threshold-gated | WebGPU + WebGL2 both use WASM-on-main-thread (no compute needed) | **Phase 2** |
| 3 | **Dense / derivable (orbital)** — positions are a closed-form function of element set + time | 10k–1M, all move/frame | **GPU compute propagator → storage buffer; positions never leave GPU**; instanced draw vertex-pulls by `instance_index` | **WebGPU-first** (compute); **WebGL2 fallback = SGP4-on-worker WASM** (WebGL2 has no compute) | **Phase 3** ⭐ |
| 4 | **Hundreds-of-thousands, arbitrary, too heavy for main-thread encode** | 100k+, arbitrary/non-derivable | **ECS-in-WASM-on-worker** → packed instance buffer → upload | Headless TaskProcessor worker (NOT scene-in-worker); SAB if COOP/COEP enabled | **Phase 4** (conditional) |

⭐ = the headline WebGPU-first feature (orbital catalog).

**Key architectural through-line:** every phase ends at the same render primitive — an instanced point/billboard draw over a per-instance buffer. Phases differ only in *how that buffer gets filled* (CPU partial write / WASM bulk encode / GPU compute / worker sim). This is what makes the regimes composable rather than competing, and is why the `_consumeDirtyState` side-effect discipline (Step 0) is a prerequisite for *all four* — a collection that re-dirties every settled object each frame defeats every fill strategy.

**Step 0 status:** the dirty-consume contract is landed only for billboards. Phase 0 below extends it to Point / Polyline / Cloud / Label-glyph; this is the foundation every later phase stands on (the manager in Phase 1, the catalog collection in Phase 3, the ECS collection in Phase 4 all need it).

---

## 2. Phase 0 — Dirty-Consume Parity

**Goal:** mirror `BillboardCollection._consumeDirtyState()` (`BillboardCollection.js:632-648`) onto the three remaining collections + the Label glyph child-collection, and call it from each WebGPU feature renderer right after instance data is captured. Without this, `updateMode`/`prepareForFeatureRenderer` re-set `_createVertexArray` and the shared scene-logic re-touches every settled primitive every frame (the billboard bug, ~4 spurious `_updateBillboard` calls/primitive/frame), the `_*ToUpdate` queues grow unbounded, and no dirty-gate or partial-write path can ever engage.

**The template** (what every task mirrors): clear per-primitive `_dirty`/`textureDirty`, reset `_*ToUpdateIndex = 0`, `_createVertexArray = false`, zero `_propertiesChanged[]`. Call site mirrors `WebGPUBillboardRenderer.js:1258` (immediately after `buildInstanceData`, before the `visibleCount===0` early return).

| Task | Collection | Mechanical mirror? | Files (add method / call site) |
|---|---|---|---|
| **P0-T1** | **Point** | ✅ Exact billboard analog | Add `PointPrimitiveCollection._consumeDirtyState()` near `PointPrimitiveCollection.js:585` (clear per-point `_dirty`, `_pointPrimitivesToUpdateIndex=0`, `_createVertexArray=false`, zero `_propertiesChanged[]`); call from `WebGPUPointPrimitiveRenderer.js:1007` after `buildInstanceData`. **Genuine per-frame-CPU fix** (shared scene-logic re-touches every point). Verify `needsRebuild` (`WebGPUPointPrimitiveRenderer.js:960`) stops firing every frame once `_pointPrimitivesToUpdate` drains. |
| **P0-T2** | **Polyline** | ⚠️ **Differs structurally** | Add `PolylineCollection._consumeDirtyState()`: set `_createVertexArray=false`, `_polylinesToUpdate.length=0`, zero collection `_propertiesChanged[]`, **and per-polyline** clear `_dirty` + zero each polyline's own `_propertiesChanged` (bucket-shaped — `_polylineBuckets` at `PolylineCollection.js:177`). **Must read the WebGL clear at `PolylineCollection.js:867-892` and the per-bucket update path at `405-519` before writing**, or it under-clears. Call once/frame in `WebGPUPolylineRenderer.js:1182` after the `groupByMaterialType`/build loop. Mostly queue/leak hygiene + future dirty-gate enablement (FR already rebuilds unconditionally). |
| **P0-T3** | **Cloud** | ⚠️ Mostly mechanical + one extra reset | Add `CloudCollection._consumeDirtyState()`: mirror WebGL clears at `CloudCollection.js:855/912/923/938/518` — clear per-cloud `_dirty`, `_cloudsToUpdateIndex=0`, `_createVertexArray=false`, **`_cloudsRemoved=false`**, zero `_propertiesChanged[]`. Call from `WebGPUCloudRenderer.ts:635` after `buildInstanceBuffer`. **Do NOT fold in** the separate count-only-rebuild-gate bug (`WebGPUCloudRenderer.ts:631` misses per-cloud property edits) — surface it as its own follow-up per Principle 9. |
| **P0-T4** | **Label (glyph child)** | ✅ Reuses existing method — no new method | Label-level `_labelsToUpdate` is already consumed (`LabelCollection.js:949`); background child-collection already consumed via `billboardFR.update` (`WebGPULabelRenderer.js:1181`). Gap: the **glyph** `BillboardCollection` is consumed only on pick frames (`WebGPULabelRenderer.js:1191-1198`); on render frames the SDF path builds directly (`buildSDFInstanceData` at `WebGPULabelRenderer.js:142`) without consuming, while `prepareForFeatureRenderer→runSharedSceneLogic` (`BillboardCollection.js:2096-2123`) re-touches every glyph. Fix: call the **existing** `glyphCollection._consumeDirtyState()` in `updateWebGPULabels` (`WebGPULabelRenderer.js:1012`) after `buildSDFInstanceData`. **Genuine per-frame-CPU fix.** Idempotent with the pick-frame consume; order matters (after the build, not before). |

**Out of scope (explicitly):** Globe terrain. `GlobeSurfaceTile._createVertexArrayForMesh` (`GlobeSurfaceTile.js:428`, also `TerrainFillMesh.js:1314`) is a *static VA-builder method*, not a boolean dirty flag — no `_*ToUpdate` queue, no per-frame flag-driven re-touch. Different caching model, no equivalent bug. **Do not add a consume there.**

**All four tasks are independent (no inter-deps), all S.** Only P0-T2 (Polyline) carries medium risk due to its per-polyline dirty shape.

**Verification:** no per-frame re-touch harness exists today (the billboard fix was "measured ≈4/frame" by inspection). Add a small probe — a `_buildCount`/`_updatePointPrimitive` counter under `Tools/visual-regression` — to confirm re-touch drops to 0 for settled scenes rather than asserting by inspection.

---

## 3. Phase 1 — Per-Instance Partial-Write Manager (sparse dynamic, Regime 1)

**Goal:** stop rebuilding+re-uploading the whole compacted instance buffer every frame. Keep a **resident CPU instance array** between frames and issue `device.queue.writeBuffer(buf, slot*stride, …, stride)` only for changed slots — O(changed), e.g. ~640 B for 10-of-50k vs 3.2 MB whole-buffer. This is the owner's explicit design verdict (`DEFERRED_WORK.md:45`, supersedes the all-or-nothing gate reverted in Batch 226).

**Unblocked at the foundation:** the per-slot write primitive already exists — `WebGPUBuffer.write(data, offset)` (`WebGPUBuffer.ts:402-415`) wraps `device.queue.writeBuffer` at an arbitrary byte offset. The per-instance dirty list exists for all three target collections (`_billboardsToUpdate` + index `BillboardCollection.js:153-154`; `_pointPrimitivesToUpdate` `PointPrimitiveCollection.js:105-106`; `_labelsToUpdate` `LabelCollection.js:656` — no index counter). Billboards already have the Step-0 fix.

### The load-bearing problem — slot-mapping under visibility compaction

The GPU slot is the running **`visibleCount`** (compacted over `show`+`clusterShow`), **NOT** `bb._index` (the dense array index). So:
- A property change to one *already-visible* instance whose slot is unchanged → **partial write** (O(1)).
- Any **add / remove / show-toggle / clusterShow change / define change / length change** shifts every downstream slot → **must force a full rebuild**.

Getting this predicate wrong is exactly how Batch 226's gate shipped stale renders. The manager must maintain a stable `_index→slot` map and decide full-vs-partial off it.

### Slot-mapping / visibility design

- **Resident CPU `Float32Array`** (interleaved, matching current 176 B billboard / 112 B point stride — keep interleaved for draw-time cache locality, do NOT split per-attribute).
- **Stable `_index→slot` map** keyed off `Billboard._index` (`Billboard.js:196`), rebuilt only on compaction-triggering events.
- **`packInstance(out, slotOffset, item)` callback** — the per-instance pack body extracted from `buildInstanceData` (`WebGPUBillboardRenderer.js:153`); the manager calls it for changed slots only (full rebuild reuses the same callback).
- **`sync(dirtyList, length) → {buffer, visibleCount, dirtyRanges}`** entry point. Reads `_billboardsToUpdate[0.._billboardsToUpdateIndex]`.
- **Dirty-range coalescing:** sort dirty slots, merge adjacent (gap·stride < small threshold) into contiguous `writeBuffer` ranges; **threshold-gated fallback** to one whole-buffer write when changed-fraction exceeds ~30-50%.
- **Velocity prev-mirror** (TAA motion vectors, `WebGPUBillboardRenderer.js:1290-1332`) must be **slot-addressed in lockstep** with the current buffer or motion vectors corrupt under partial writes.

### Shared-base angle

The manager should land **as part of / paired with `NEW-COLLECTION-RENDERER-BASE`** (the ~3000-LOC duplication across the 4 collection renderers, tracked at `audits/2026-06-11_ULTRA_REVIEW_findings.json:231`). Recommended sequencing: **build the manager standalone first** (so it's verifiable in isolation), **fold into the base last** — bundling the base extraction up front risks scope creep into a large multi-renderer refactor.

### Tasks

| Task | Title | Effort | Deps |
|---|---|---|---|
| **P1-T1** | Step-0 re-dirty parity for **Point + Label** (`_consumeDirtyState` + stop readiness loop / unreset `_createVertexArray` re-pushing settled instances). *Overlaps Phase 0 P0-T1/P0-T4 — this is the same fix, gated tighter: verify with a `_buildCount` probe over static-then-dynamic frames that settled instances are NOT re-dirtied AND moving instances DO update.* | M | none (prereq for everything) |
| **P1-T2** | Build `WebGPUResidentInstanceBuffer` manager: resident CPU array + GPU buffer + stable `_index→slot` map + full-vs-partial predicate + `packInstance` callback + `sync()`. **The only L task.** | L | P1-T1 |
| **P1-T3** | Dirty-range coalescing + changed-fraction fallback to whole-buffer write. | M | P1-T2 |
| **P1-T4** | Wire `WebGPUBillboardRenderer` onto the manager: replace `buildInstanceData()`+full `writeBuffer` (`:1251-1340`) with `manager.sync()`; extract `packInstance`; keep velocity prev-mirror slot-aligned. Probe-verify static-skip + single-instance partial + moving-update vs WebGL. | M | P1-T2, P1-T3 |
| **P1-T5** | ✅ SHIPPED (Batch 232). Wire **Point + Label** onto the manager (subsumed Point's `needsRebuild` gate). The "dirty-list adapter" turned out unnecessary: the glyph BillboardCollection's own `_billboardsToUpdate`/`_billboardsToUpdateIndex` is the dirty list; label is wired full-rebuild-on-any-dirty because glyph granularity is unsound for per-slot writes (`repositionAllGlyphs` direct field writes; `rebindAllGlyphs` slot re-purposing) — settled frames still upload nothing. Atlas-guid rotation forces full rebuild (covers SDF atlas `textureDirty`). See DEFERRED_WORK NEW-PARTIAL-WRITE-WIRE-BPL. | M | P1-T4 |
| **P1-T6** | Fold manager into `NEW-COLLECTION-RENDERER-BASE`; close `NEW-COLLECTIONS-DIRTY-GATE` in `DEFERRED_WORK.md:43-45`; update FEATURE_INVENTORY. | M | P1-T4, P1-T5 |

**Risks:** slot-map invalidation on compaction (the crux); velocity prev-mirror slot-alignment; Label atlas-rebuild coupling. `writeBuffer` 4-byte alignment is safe (176/112 B strides are 16-byte aligned) — guard if a future stride isn't a multiple of 4.

---

## 4. Phase 2 — Flat-Buffer `Buffer*` Collections + WASM Encode Kernel (dense arbitrary, Regime 2)

**Goal:** for 10k–100k bulk position updates that are *set externally* (not derivable), replace the per-primitive scalar JS `EncodedCartesian3.fromCartesian` encode loop with the **existing-but-dead** WASM RTE-encode kernel. This is the WebGL2 fallback story for the dense regime (WebGL2 has no compute, so WASM-on-main-thread is the answer) **and** a CPU-encode win on WebGPU.

**~80% pre-built — this is a wiring task, not greenfield:**
- **SoA `Buffer*` collections** (flyweight, zero per-object wrappers): `BufferPrimitiveCollection.js` (flat `_primitiveView`/`_positionView`/`_materialView`, contiguous dirty-range `_dirtyOffset`/`_dirtyCount`/`_makeDirty` at `:553-563`), `BufferPointCollection.js`, sibling `BufferPolygon*`/`BufferPolyline*`. WebGPU renderers `WebGPUBufferPointRenderer.ts` etc. registered as FRs (keys 33/34/35, `WebGPUFeatureRenderers.ts:264`). WebGL reference `renderBufferPointCollection.js`.
- **WASM kernel + bridge already compiled into `cesium_wasm_bg.wasm`:** `batch_rte_encode` (`packages/wasm/src/rte_encode.rs:32-51`) + `batch_rte_encode_soa` (`:66-98`); bridge `WasmRTEBridge.batchEncode` (`WasmRTEBridge.js:76-121`) with WASM path + byte-exact `Math.fround` JS fallback (`:124-132`), threshold gate (=100), arena slot `RTE=5` (`WasmArenaSlots.js:49`), feature/SIMD/version detection — follows every CLAUDE.md WASM-strategy bullet.

**The gap is purely connective.** `WasmRTEBridge.batchEncode` has **zero consumers** (grep confirms only self-references). Both the WebGPU `repackPointDirty` (`WebGPUBufferPointRenderer.ts:284-340`) and the WebGL `renderBufferPointCollection.js:106-156` encode positions in a per-primitive scalar JS loop. Two missing pieces: (1) `batchEncode` encodes only from index 0 (confirmed at `WasmRTEBridge.js:76` — `subarray(0, total)` at `:106`); it needs a **sub-range variant** to encode the dirty `[offset, offset+count)` slice at the matching out-offset. (2) No bridge is instantiated or threaded into the repack hot paths.

**Upstream pulls — adoption + correctness gate:**
- **#13465** (`FORK_DRIFT_ANALYSIS_2026-06-11.md:101`) — `BufferPointCollection` update-staleness fix (position changes don't re-render; likely the position change marks BV dirty but not primitive `_dirty`, so repack skips it). **Must land before/with the benchmark** — any perf number over a stale-render path is meaningless.
- **#13448** (Buffer* `modelMatrix`/BV become readonly + Node 22) — a **breaking change for the next full upstream sync, NOT a now-pull.** Awareness only: new encode code must not write `modelMatrix`/`boundingVolume` post-construction.

### Tasks

| Task | Title | Effort | Deps |
|---|---|---|---|
| **P2-T1** | Add sub-range support to `WasmRTEBridge.batchEncode` (encode dirty `[offset,count)` into out-arrays at offset) + matching JS fallback; unit test vs scalar `EncodedCartesian3`. **Extend, don't recreate** (no-shortcuts principle). | S | none |
| **P2-T2** | Wire the RTE fast-path into `WebGPUBufferPointRenderer.repackPointDirty` (`:284-340`): gate on `_dirtyCount ≥ threshold`, feed the contiguous `_positionView` slice (for points `vertexOffset==index` → contiguous f64 XYZ, zero deinterleave), keep color/pick/outline interleave in JS. Instantiate bridge on `PointCache`, destroy in `destroyWebGPUBufferPointCollection` (`:489-506`). | M | P2-T1 |
| **P2-T3** | Apply the same routing to the WebGL `renderBufferPointCollection.js` encode loop (Principle-5 parity; WebGL2 = WASM-on-main-thread for this regime). | S | P2-T1 |
| **P2-T4** | Port upstream **#13465** staleness fix + regression spec. Land before/with P2-T2. | S | none |
| **P2-T5** | Benchmark 10k/50k/100k bulk-update repack: scalar JS vs WASM, both backends; tune threshold; Playwright probe confirming no visual regression vs WebGL (Principle 8). | M | P2-T2, P2-T3, P2-T4 |
| **P2-T6** | *Optional* wider kernel: `batch_encode_point_instances` in `rte_encode.rs` (position high/low + RGB8 color/outline in one pass), bump WASM version (`lib.rs:193` + `WasmFeatureDetection.js` `EXPECTED_WASM_VERSION`), route Polygon/Polyline repack through it. **Only if P2-T5 shows the JS color-pack loop is the residual bottleneck.** Polygon/polyline positions are non-contiguous (index→vertex) so they need this wider kernel, not a simple slice. | L | P2-T5 |
| **P2-T7** | Sync-planning note: track **#13448** (readonly props, Node 22) as a next-merge breaking change; ensure encode code doesn't mutate `modelMatrix`/BV post-construction. | S | none |

**Risks:** the win may be modest if GPU `writeBuffer` upload dominates over CPU encode at these counts — **measure (P2-T5) before claiming** (Principle 8). Async WASM load means first frames always run the JS fallback (which is byte-exact). Do **not** treat the dead `WasmRTEBridge` as removable (Principle 7) — it's scaffolding for exactly this task.

---

## 5. Phase 3 — GPU-Compute Orbital Propagator + Storage-Buffer Instance Path (dense derivable, Regime 3) ⭐

**Goal — the headline WebGPU-first feature.** For positions that are a closed-form function of an element set + time (satellite/debris catalogs, 10k–1M objects, *all moving every frame*), keep positions **on the GPU**: upload the element catalog **once** to a read-only storage buffer, dispatch a compute propagation per frame writing positions into an output storage buffer, and **vertex-pull `position[instance_index]`** in an instanced draw. No CPU round-trip, no per-frame upload.

> **Status (Batch 230 → 231, NEW-COMPUTE-INSTANCE-SYSTEM ✅):** the Batch-230 circular-orbit MVP shipped this regime end-to-end, then an owner directive split it: the **engine feature is the feature-agnostic compute-instance system** — `Scene/ComputeInstanceCollection.js` (N instances, flat user-defined param lanes uploaded once, per-frame CPU upload = one time scalar) + `WebGPUComputeInstanceRenderer.ts` (composes `ComputeInstanceScaffold.wgsl` + a USER-SUPPLIED WGSL kernel `csm_computeInstance(index, time) -> {position, color, pixelSize}`; engine owns bindings/bounds-check/RTE split) + `ComputeInstanceRender.wgsl` (instanced vertex-pull draw). **Everything orbital — the element layout, the circular-orbit kernel, the LEO/MEO/GEO catalog generation — is Sandcastle demo + probe content**; the engine retains zero orbital domain knowledge. The SGP4/J2/GMST plans below therefore describe **kernel-level demo upgrades** (and a future df64 helper library for kernels), while picking / TAA motion vectors / boundingVolume cull / the WebGL2 worker-WASM fallback are **generic-system upgrades** — see the re-labeled NEW-ORBITAL entries + NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK in DEFERRED_WORK.md.

### Feasibility — the critical question is answered YES

*Can an instanced draw read per-instance position from a storage buffer by `instance_index` in the current WGSL/pipeline setup?* **Yes**, with a complete working precedent:
- `WeatherParticleRender.wgsl:49` — `@group(0)@binding(0) var<storage,read> particles` + `:81` `@builtin(instance_index)` → per-instance position → camera-facing quad. **This is exactly storage-buffer-vertex-pulling-by-instance-index, already compiling and running.**
- The same `GPUBuffer` is `STORAGE|COPY_DST|VERTEX` (`WebGPUWeatherRenderer.ts:213-218`); `renderBindGroupLayout` uses `storageBuffer(0, Stage.VERTEX, {readOnly:true})` (`:419`) — proves `Stage.VERTEX` storage reads work in the current pipeline.
- Compute infra all SHIPPED: `WebGPUComputeEngine.executeOnEncoder` (`:265`, interleave compute with render on the shared encoder), `WebGPUComputeCommand` (`:65`), `WebGPUStorageBufferPool` (`:103/148/181`), central pipeline cache.

**No new low-level plumbing.** The whole orbital renderer is the weather renderer *minus the camera-delta sim, plus SGP4*.

### SGP4 kernel

**Fully greenfield** — grep for SGP4/TLE/keplerian/meanAnomaly/propagate found **zero** orbital code. This is the dominant effort, not the GPU integration. Plan:
1. **Prototype a simplified secular-J2 mean-element propagator** first (far simpler than full SGP4/SDP4) to validate the end-to-end pipeline.
2. **Upgrade to full SGP4 (near-earth)** with CPU FP64 mean-element pre-conditioning; validate against python-sgp4 / Vallado test vectors within a documented position tolerance.
3. **Cap v1 at near-earth SGP4; defer SDP4** (deep-space resonance terms are FP32-hostile).

### RTE / precision decision (must settle before coding)

Orbital ECEF positions are 6.4e6–4.2e7 m; a single f32 loses ~1m+. The output **must** be either RTE high/low (24 B/element) **or** camera-relative (kernel subtracts FP64 camera, weather-style). Two options:
- **Kernel emits camera-relative** positions (weather precedent), or
- **Kernel emits absolute-ECEF high/low** and the vertex shader subtracts camera (point precedent, reuse `PointPrimitiveColor.wgsl:84` quad/RTE-translate).

Picking wrong reintroduces planetary-scale jitter. Write a 1-pager (P3-T1).

### Device limits

`maxStorageBufferBindingSize` default 128 MB (`WebGPUDevicePool.ts:120-180` negotiates up to adapter ceiling) → ~5.6M RTE positions (24 B) or ~2.7M full-element records (48 B) per binding. **1M+ catalogs may need a multi-SSBO split** (elements SSBO + positions SSBO, or catalog split across bindings). Validate via probe (P3-T2).

### WebGL2 fallback (no compute)

SGP4-on-worker WASM bridge, writing the **same SoA RTE position buffer** the WebGL instanced/`BufferPoint` draw reads (match `WebGPUBufferPointRenderer.ts:108-119` layout so one fragment/quad shader serves both backends). Slots into the 7 existing `Wasm*Bridge` patterns (`WasmRTEBridge`, `WasmPointCloudBridge`, …); double-buffer + tolerate 1-frame staleness like the cull/sort readback rings.

### Tasks

| Task | Title | Effort | Deps |
|---|---|---|---|
| **P3-T1** | Define element data model + buffer layouts (element SSBO, per-frame time uniform, RTE high/low output SSBO); decide RTE-encode location. 1-pager. | S | none |
| **P3-T2** | Validate device-limit feasibility for the 1M target (`maxStorageBufferBindingSize`, `maxComputeInvocationsPerWorkgroup`, `maxComputeWorkgroupsPerDimension`) via Playwright probe against the device pool; decide single- vs multi-binding split. | S | P3-T1 |
| **P3-T3** | Prototype simplified **secular-J2** mean-element propagator in WGSL (read `element[i]`+time → ECEF → RTE-encode → write `position[i]`); mirror `WeatherParticles.wgsl` struct+dispatch shape; validate vs a CPU FP64 reference within a stated tolerance. | M | P3-T1 |
| **P3-T4** | Build `WebGPUOrbitalCatalogRenderer.ts` end-to-end on the weather template: upload catalog once, dispatch per frame via `executeOnEncoder`, instanced draw vertex-pulling `position[instance_index]` (reuse `PointPrimitiveColor` quad/fragment). Respect the *close-render-pass-before-`beginComputePass`-on-shared-encoder* discipline (`WebGPUSceneRenderer._executeGBufferProducer` pattern, `:2009-2076`). | M | P3-T2, P3-T3 |
| **P3-T5** | Scene-level `OrbitalCatalogCollection` (or `PointPrimitiveCollection` GPU-resident mode): owns element catalog, dirty-state for epoch/element edits, **`_consumeDirtyState` discipline** (per the billboard fix — else every settled element re-dirties each frame), FeatureRendererKey registration, per-frame compute scheduling. | M | P3-T4 |
| **P3-T6** | Upgrade kernel secular-J2 → **full SGP4** (near-earth) with CPU FP64 pre-conditioning; validate vs reference SGP4 within documented tolerance; cap at SGP4, defer SDP4. | L | P3-T4 |
| **P3-T7** | **WebGL2 fallback:** SGP4-on-worker WASM bridge (new Rust crate alongside `wasm-naga`/`packages/wasm`) writing the same SoA RTE position buffer; destroy/free_buffer/version/SIMD/JS-fallback per WASM strategy; threshold-gated; double-buffered with 1-frame staleness tolerance. | L | P3-T5, P3-T6 |
| **P3-T8** | GPU picking for 1M GPU-resident points (no CPU position to hit-test): GPU pick pass or coarse CPU bounding-volume prefilter. Plus Sandcastle demo + visual-regression probe (WebGL WASM vs WebGPU compute parity). **Picking GPU-resident geometry has no upstream pattern — may defer to a follow-up.** | M | P3-T5, P3-T7 |
| **P3-T9** | Track regime in migration_doc: add `NEW-ORBITAL-GPU-RESIDENT` to `DEFERRED_WORK.md`, move FEATURE_INVENTORY §D→§C as it ships, document the element/time/output contract. | S | P3-T1 |

**Risks:** FP32 SGP4 drift is the dominant risk (reference is FP64, numerically sensitive) — needs an accuracy budget + FP64 reference diff. RTE precision (see decision above). Command-list integration adds a wrinkle the weather precedent sidesteps (weather draws directly in `_executeEnvironmentalEffects`, not via `WebGPUDrawCommand`); routing through the command list to get culling/sort/picking needs a `bindGroupResolver` (`WebGPUDrawCommand.ts:175`) for per-frame storage rebind + `drawIndirect` (`:540`) if a GPU cull writes `instanceCount`. Effort is **L (multi-week), dominated by SGP4 correctness, not GPU integration.**

---

## 6. Phase 4 — ECS-in-WASM-on-Worker (conditional, Regime 4)

**Gating call: LIKELY NOT NEEDED. Build the spike, not the system.**

ECS-on-worker earns its multi-week cost **only** when updates are *simultaneously* (a) hundreds-of-thousands+, (b) **arbitrary** (not GPU-derivable from a closed-form propagator), and (c) too heavy for a single main-thread WASM encode pass at 60fps. That intersection is narrow — for satellite/debris catalogs (the stated real target) Regime 3 (derivable) and Regime 2 (dense-arbitrary via SoA+WASM) almost certainly cover it. **Recommendation: defer behind Phases 2 and 3; gate the whole phase behind a time-boxed go/no-go spike that produces a measured number, not a commitment.**

**Substrate exists but in the wrong arrangement:**
- **Right shape for a headless sim:** `TaskProcessor.js` (worker pool, transferable detection) + `createTaskProcessorWorker.js` (headless adapter, `transferableObjects` out-param at `:59`). **Use this, NOT** `RendererWorker.js`/`WorkerSceneHost.js` — those are *scene-in-worker* (OffscreenCanvas + full Scene), DOM-blocked (`ScreenSpaceEventHandler`, `OPTION_B §1.3`), estimated 9-13 weeks. An ECS sim needs none of that.
- **SoA component substrate:** `BufferPrimitiveCollection.js` (typed Layout, flyweight `get(index,result)`, dirty-range), `SOABoundingSphereLayout.js` (split arrays + `useSharedMemory` flag at `:46`). Render-collection-specific and single-threaded — not yet a component registry with systems/lifecycle.
- **WASM-kernel-over-SoA template:** `WasmCullBridge.js` (threshold-gated WASM-vs-JS, arena, version/SIMD, JS fallback) — model the sim/encode kernel on this.

**Hard blockers if the full system is built:**
- **No ECS exists** — no entity/component/system framework, no object-pool (`**/*ObjectPool*` = zero hits), no archetype/free-list/generational-id allocator. Greenfield framework with no in-fork pattern → high over-build risk; keep workload-driven and minimal.
- **SharedArrayBuffer unavailable today** — COOP/COEP headers set *nowhere* (`server.js:179` sets only CORS `*`; `web.config` only MIME maps). So `SharedResourcePool`, `SOABoundingSphereLayout(useSharedMemory)`, `WasmCullBridge` all silently fall back to plain ArrayBuffer. **Without SAB the worker can only `postMessage`-transfer results per frame, not share live memory** — the zero-copy promise collapses to double-buffered transfer, which may erase the benefit entirely. Enabling COOP/COEP is itself risky (`OPTION_B §5.2`: breaks third-party embeds).
- **RTE precision:** worker must emit RTE-split `positionHigh`/`positionLow` (CLAUDE.md 64-bit rule), not raw f32 — easy to get wrong in f32 SIMD/WASM.

### Tasks

| Task | Title | Effort | Deps |
|---|---|---|---|
| **P4-T1** | **SPIKE/GATING:** flat-SoA + WASM-encode main-thread path on `BufferPointCollection`; instrument the main-thread encode/upload ceiling (objects/frame at 60fps) for *arbitrary* updates. **Output: the go/no-go number.** | M | none |
| **P4-T2** | **SPIKE:** headless ECS-sim `TaskProcessor` worker (NOT `RendererWorker`) running a trivial position-integration system over SoA arrays, returning a packed instance ArrayBuffer via transferable. Measure transfer cost vs in-worker sim cost vs P4-T1. **If transfer dominates, ECS-worker is dead-on-arrival without SAB.** | M | P4-T1 |
| **P4-T3** | ECS substrate (no worker yet): component-array registry, sparse-set/archetype allocator with generational ids + free-list, minimal system scheduler. Pure JS first, WASM-bridge seam designed in. **Only if P4-T2 justifies a worker.** | L | P4-T2 (conditional) |
| **P4-T4** | COOP/COEP enablement for SAB: add headers to `server.js` + `web.config`, audit embed breakage (`OPTION_B §5.2`), flip `SharedResourcePool`/`SOABoundingSphereLayout` to real SAB with feature-detect + ArrayBuffer-transfer fallback. | M | P4-T2 |
| **P4-T5** | ECS-in-WASM kernel: port hot systems to WASM (new `WasmArenaSlot`, version/SIMD, JS fallback) over SAB-backed component arrays in the worker; threshold-gated like `WasmCullBridge`. | L | P4-T3, P4-T4 |
| **P4-T6** | Render upload bridge: wire worker output (SAB view or transferred buffer) into `BufferPointCollection._positionView`/`_renderContext` (WebGL2) and a WebGPU storage/instance buffer; double-buffer to avoid sim/render tearing; **worker must emit RTE high/low**. | L | P4-T3 |
| **P4-T7** | Productionize: lifecycle/crash-recovery (reuse `WorkerSceneHost` patterns), picking over worker-owned entities, capacity growth/compaction, WebGL2 fallback, docs + DEFERRED_WORK/FEATURE_INVENTORY. **Long tail — only if P4-T1/T2 proved the regime is real and uncovered by 2/3.** | L | P4-T5, P4-T6 |

**Do not remove** the OPTION_B scaffolding, `SharedResourcePool`, `SOABoundingSphereLayout(useSharedMemory)`, or stub message types (Principle 7) — they are the seams this phase fills.

---

## 7. Cross-Phase Dependencies + Recommended Build Order

### Dependency graph (high level)

```
Phase 0 (dirty-consume parity) ──────┬──> Phase 1 (partial-write manager)
   P0-T1 Point ≡ P1-T1 (Point half)  │       needs Step-0 for Point+Label
   P0-T4 Label ≡ P1-T1 (Label half)  │
                                      ├──> Phase 3 (orbital collection P3-T5
                                      │       needs _consumeDirtyState discipline)
                                      └──> Phase 4 (ECS collection needs it too)

Phase 2 (SoA + WASM encode) ─── independent of 0/1 ───┐
   shares WASM bridge pattern + SoA Buffer* substrate  │
   WasmRTEBridge sub-range (P2-T1) ───────────────────┼──> Phase 3 WebGL2 fallback
   reused by Phase 3 P3-T7 (SGP4-on-worker writes      │       (P3-T7 SGP4 bridge)
   same SoA RTE buffer)                                 │
                                                        └──> Phase 4 P4-T1 spike
                                                             (built ON the SoA path)
```

**Critical shared artifacts (build once, reused downstream):**
- `_consumeDirtyState` contract (Phase 0) → consumed by Phase 1 manager, Phase 3 collection, Phase 4 collection.
- `WasmRTEBridge` sub-range encode (P2-T1) → reused by Phase 3 WebGL2 fallback (P3-T7) and the Phase 4 spike (P4-T1).
- SoA `Buffer*` position layout (Phase 2) → the Phase 3 output buffer (P3-T7) and Phase 4 upload (P4-T6) must match it so one fragment/quad shader serves all.
- `NEW-COLLECTION-RENDERER-BASE` → the Phase 1 manager folds into it (P1-T6).

### Recommended build order

1. **Phase 0 first, in full** (P0-T1…P0-T4). Cheap (4×S), unblocks everything, and P0-T1/P0-T4 *are* the Point/Label half of Phase 1's prerequisite. Land the re-touch probe here.
2. **Phase 2 in parallel** with Phase 0 (no dependency). It's the highest-ROI *connective* work (kernel already compiled, just dead), ships the WebGL2 story for the dense regime, and produces `WasmRTEBridge` sub-range encode that Phase 3 and Phase 4 both reuse. **Land #13465 (P2-T4) before benchmarking.**
3. **Phase 1** next. Foundation-unblocked (`WebGPUBuffer.write` exists); P1-T2 is the only L. Closes the long-standing `NEW-COLLECTIONS-DIRTY-GATE`. Build the manager standalone (P1-T2…P1-T5), fold into the base last (P1-T6).
4. **Phase 3** — the headline. Start P3-T1/P3-T2 (decisions + feasibility probe) early; they can overlap Phases 1-2. Prototype secular-J2 (P3-T3) before SGP4 (P3-T6) to de-risk the pipeline. Effort is dominated by SGP4 correctness, so front-load the validation harness.
5. **Phase 4 — spike only (P4-T1/P4-T2), then STOP.** Treat as a time-boxed go/no-go that produces the main-thread-encode ceiling number. **Do not commit to P4-T3…T7 without a measured workload** that is simultaneously 100k+, arbitrary, and over that ceiling.

**One-line order:** `Phase 0 ∥ Phase 2 → Phase 1 → Phase 3 → Phase 4-spike (gate)`.

---

## 8. NEW-* Deferred IDs to add to DEFERRED_WORK.md

(See structured `newDeferredItems` for the machine-readable list — id / title / phase / effort.)

| ID | Phase | Effort | One-liner |
|---|---|---|---|
| `NEW-DIRTY-CONSUME-POINT` | 0 | S | Mirror `_consumeDirtyState` on PointPrimitiveCollection + call from FR (genuine per-frame-CPU fix). |
| `NEW-DIRTY-CONSUME-POLYLINE` | 0 | S | Bucket-aware `_consumeDirtyState` on PolylineCollection (per-polyline `_dirty`/`_propertiesChanged` + `_polylinesToUpdate`). |
| `NEW-DIRTY-CONSUME-CLOUD` | 0 | S | `_consumeDirtyState` on CloudCollection incl. `_cloudsRemoved` reset. |
| `NEW-DIRTY-CONSUME-LABEL-GLYPH` | 0 | S | Call existing glyph `_consumeDirtyState` in SDF render path (genuine per-frame-CPU fix). |
| `NEW-CLOUD-REBUILD-DIRTY-GATE` | 0 | S | Separate follow-up: WebGPUCloudRenderer count-only rebuild gate (`:631`) misses per-cloud property edits. |
| `NEW-COLLECTION-RETOUCH-PROBE` | 0 | S | Visual-regression probe asserting settled-scene re-touch count → 0. |
| `NEW-RESIDENT-INSTANCE-BUFFER-MGR` | 1 | L | Resident CPU array + stable `_index→slot` map + full-vs-partial predicate + per-slot `writeBuffer`. (closes `NEW-COLLECTIONS-DIRTY-GATE`) |
| `NEW-PARTIAL-WRITE-COALESCING` | 1 | M | Dirty-range coalescing + changed-fraction whole-buffer fallback. |
| `NEW-PARTIAL-WRITE-WIRE-BPL` | 1 | M | Wire Billboard/Point/Label renderers onto the manager; slot-aligned velocity prev-mirror. |
| `NEW-COLLECTION-RENDERER-BASE` | 1 | M | Shared base for the 4 collection renderers; manager folds in (already tracked at findings.json:231). |
| `NEW-WASMRTE-SUBRANGE-ENCODE` | 2 | S | Sub-range variant of `WasmRTEBridge.batchEncode` (encode dirty `[offset,count)`). |
| `NEW-BUFFERCOLL-WASM-ENCODE-WIRE` | 2 | M | Route WASM encode into WebGPU+WebGL Buffer* repack hot paths, threshold-gated. |
| `NEW-UPSTREAM-13465-BUFFERPOINT-STALENESS` | 2 | S | Port upstream #13465 update-staleness fix + regression spec (gates benchmark). |
| `NEW-BUFFERCOLL-ENCODE-BENCHMARK` | 2 | M | Benchmark 10k/50k/100k scalar-vs-WASM both backends + visual-regression probe. |
| `NEW-WASM-WIDE-INSTANCE-KERNEL` | 2 | L | Optional single-pass position+color/outline kernel for Polygon/Polyline (non-contiguous); gated on benchmark. |
| `NEW-UPSTREAM-13448-READONLY-PROPS` | 2 | S | Next-sync breaking-change note: Buffer* modelMatrix/BV readonly + Node 22. |
| `NEW-ORBITAL-DATA-MODEL` | 3 | S | Element SSBO + time uniform + RTE output layout; decide RTE-encode location (1-pager). |
| `NEW-ORBITAL-DEVICE-LIMITS-PROBE` | 3 | S | Validate storage/compute limits for 1M target; single- vs multi-binding split. |
| `NEW-ORBITAL-J2-KERNEL` | 3 | M | Simplified secular-J2 WGSL propagator (validate pipeline before SGP4). |
| `NEW-ORBITAL-GPU-RESIDENT-RENDERER` | 3 | M | `WebGPUOrbitalCatalogRenderer` on the weather template (compute→storage→instanced draw). |
| `NEW-ORBITAL-CATALOG-COLLECTION` | 3 | M | Scene-level catalog collection with dirty-state + `_consumeDirtyState` discipline + FR registration. |
| `NEW-ORBITAL-SGP4-KERNEL` | 3 | L | Full near-earth SGP4 in WGSL + FP64 pre-conditioning + reference-vector validation (defer SDP4). |
| `NEW-ORBITAL-SGP4-WASM-WORKER` | 3 | L | WebGL2 fallback: SGP4-on-worker WASM bridge writing the same SoA RTE buffer; double-buffered. |
| `NEW-ORBITAL-GPU-PICKING` | 3 | M | Picking for 1M GPU-resident points (GPU pick pass / coarse BV prefilter) + Sandcastle + parity probe. |
| `NEW-ORBITAL-INVENTORY-TRACK` | 3 | S | Add `NEW-ORBITAL-GPU-RESIDENT` to DEFERRED_WORK + FEATURE_INVENTORY §D→§C. |
| `NEW-ECS-WORKER-GATING-SPIKE` | 4 | M | Measure main-thread WASM-encode ceiling (SoA path) — the go/no-go number. |
| `NEW-ECS-HEADLESS-WORKER-SPIKE` | 4 | M | Headless TaskProcessor sim worker; measure transfer cost vs main-thread. |
| `NEW-ECS-SUBSTRATE` | 4 | L | Component registry + archetype/sparse-set allocator + system scheduler (conditional on spike). |
| `NEW-COOP-COEP-SAB-ENABLE` | 4 | M | COOP/COEP headers + SAB flip with feature-detect fallback (embed-breakage audit). |
| `NEW-ECS-WASM-KERNEL` | 4 | L | Hot ECS systems in WASM over SAB-backed component arrays. |
| `NEW-ECS-RENDER-UPLOAD-BRIDGE` | 4 | L | Wire worker output into Buffer* / WebGPU storage buffer; RTE high/low; double-buffer. |
| `NEW-ECS-PRODUCTIONIZE` | 4 | L | Lifecycle/crash-recovery/picking/compaction + WebGL2 fallback + docs (long tail). |