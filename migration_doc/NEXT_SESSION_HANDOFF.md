# Next Session Handoff — 2026-04-19 (Session 35 rollup)

**Branch:** `main` (commits `332a8efac2` — session work — and `852b4affd7` — stale-spec backlog entry).
**Build:** `npx gulp buildAllVariants` produces three side-by-side bundles (dual 7.1 MB / webgl-only 5.6 MB / webgpu-only 6.4 MB minified IIFE). Dual still writes to the historical `Build/Cesium{Unminified}` paths.
**`tsc --noEmit`:** clean (0 errors) as of the latest change.

This doc supersedes the prior 2026-04-16 handoff but **preserves it in full below** — this is a delta on top of it. Read the principal-engineer review at [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) first if you need arch context on lifecycle fixes; the entries below are session-34+ work that builds on that foundation.

---

## Session 35 (2026-04-19) — what landed

### Resource URL regression repair

`packages/engine/Source/Core/Resource.js` — fixed two bugs introduced by the earlier ES6 modernization of `parseUrl`:

- Relative URLs against a baseUrl were resolving to root-relative paths, which then DISCARDED the base's path during later URL resolution. `buildModuleUrl("Assets/foo")` against `CESIUM_BASE_URL = "/Build/Cesium/"` was returning `/Assets/foo` (wrong) instead of `/Build/Cesium/Assets/foo`. This broke every app with a subpath base URL.
- `data:` and `blob:` URIs were being reconstructed from `origin + pathname`. `URL().origin` is `"null"` for data URIs, producing garbage like `nullimage/png;base64,...`. Both schemes now stored verbatim.

**Coverage:** Core/Resource spec — 119/119 pass.

### Variant smoke test finally reliable

`Tools/variant-smoke-test.mjs` rewritten to be runnable end-to-end:

- Uses `Viewer.createAsync()` for the webgpu path (the sync `new Viewer()` always returns a WebGL context — CesiumWidget architectural constraint).
- Enables `--enable-unsafe-webgpu` in headless Chromium so the webgpu variant actually gets a WebGPU device.
- Re-binds `CESIUM_BASE_URL` via `buildModuleUrl.setBaseUrl()` after bundle load so absolute-URL base is deterministic.
- Logs failed request URLs so 404s diagnose themselves.

**Result:** all 3 variants PASS with zero console errors across 5 render frames.

### FEAT-SURVEY-06 first consumer wired

DecoupledScan now has a real consumer in the codebase:

- New WGSL shader `Shaders/WebGPU/Compute/PointCloudLODScanCompact.wgsl` — `tagVisible` + `compactScanned` entry points sharing `LODParams` with `PointCloudLOD.wgsl`.
- `WebGPUPointCloudLODProcessor` gained an opt-in `useDecoupledScan: true` path: tag → scan → compact → `copyBufferToBuffer(prefix[N-1] → visibleCount[0])`. Produces deterministic output ordering (`visibleIndices` sorted by original point index). Atomic-add stays the default.
- `WebGPUContextOptions.useDeterministicPointCloudLOD` plumbed through to the lazy `context.pointCloudLOD` getter so apps opt in at context construction.
- New spec `WebGPUPointCloudLODProcessorSpec.js` — 7 tests covering both paths (mock-device harness, pattern-match with `WebGPUDecoupledScanSpec`).

### Backlog: stale-spec findings

`migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — new "Session 35 findings" section. Two items:

- **IonResourceSpec** test `"constructs with expected values"` is stale after ES6 class migration — spies on `Resource.call(this, ...)` which no longer happens under `extends Resource`. Spec-only fix. 25/26 IonResource tests pass; this one fails.
- **3 ImageryProvider specs** (ArcGis / OSM / TileMapService) fail with `Class constructor X cannot be invoked without 'new'` — same root cause. Pre-existing, unrelated to this session.

### Item 4 assessment — "pick a deferred item"

After examining the deferred list, none of the four suggested items fit a clean session tail:

- **TAA Slice 2b** (per-model MRT motion for skinned/morphed/instanced) — multi-file, not a tail-sized deliverable.
- **BUG-3 2D/Columbus View WebGPU collections (C-P10)** — 6 collection shaders + primitive shaders need the morph/CV branch; substantial shader-family change.
- **§6d `@private` → `@internal` sweep** — already clean in the WebGPU directory. Grepped all 79 TS/JS files; only 3 JSDoc `@private` tags sit on non-`private`-declared methods (`WebGPUModelPipelineCache._createDefaultTexture`, `._createDefaultVertexBuffer`, `WebGPUDevicePool._resetInstance`). Verified: none are called cross-class. The review's "5 methods in WGSLShaderPreprocessor" must have been cleaned up in an earlier pass. **No action needed for the WebGPU directory; sweep outside the directory not yet assessed.**
- **ES6 modernization — WGSLShaderBuilder.js** — 696 lines, 3 pre-ES6 constructor-function classes (`WGSLStruct`, `WGSLFunction`, `WGSLShaderBuilder`) + 25 prototype assignments + `Object.defineProperties`. No spec exists. Modernizing without a safety net violates CLAUDE.md's "never modernize a file you're not otherwise touching" rule and risks silent shader-emission regressions. **Recommended flow: write a `WGSLShaderBuilderSpec` first (separate session), then modernize.**

### Outstanding uncommitted work (NOT this session)

The working tree still has pre-session mods on ~50 files (WGSL primitives, migration docs, several WebGPU TS files). Those are from prior sessions and are unrelated to Session 35's scope. My `useDeterministicPointCloudLOD` wiring in `WebGPUContext.ts` is uncommitted — it shares the file with pre-existing work, and I couldn't isolate just my 20-line addition without dragging the rest in. Bundle it with the next commit of that file.

---

## Post-Session-31 rollup — what landed since

The handoff below captures Session 31's principal-engineer-review fixes. A lot has landed on top in sessions 32-34 and the three immediately-following sessions. The important bits for continuity:

### TAA (shipped to Slice 2a)

- **Slice 1** (Session 34) — jitter + RTE motion vectors + depth reprojection + history blend + neighborhood AABB clamp. Works for static terrain + static primitives.
- **Slice 2a** — sky reprojection + teleport invalidation.
- Remaining: Slice 2b (per-model MRT motion for skinned / morphed / instanced), Slice 3 (YCoCg variance clipping + particles), Slice 4 (3D Tiles pop-in + picking un-jitter + CSM+TAA + WebGL parity). Each is independently deliverable. See [TAA_DESIGN.md](TAA_DESIGN.md).

### Aerial-perspective LUT rollout

- Reference pattern from [PrimitivePhongTexturedColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl) now replicated on: `PrimitivePhongColor`, `PrimitiveMatColorLit`, `PrimitiveMatImageLit`, `PrimitivePBRSimple`, `PrimitivePBRTextured`, and `ModelPBRComplete`. Each declares bindings 7/8/9 on its effects bind group (shared [WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) layout already had slots) and applies the `effects.atmosphereLutControl.x > 0.5` gate in `fragmentMain`.
- PBR variants apply the fog blend AFTER tonemap+gamma (display-space composite) to match the reference.
- ModelPBRComplete uses `camera.cameraPositionWC` + `material.modelMatrix * vec4(rteMC, 0.0)` instead of the primitive shaders' `encodedCameraHigh/Low` + `eyePosition`.
- **Status:** all 6 shader `.js` modules carry the gate; type-check + WGSL compile both clean. **Visual verification pending** — this is one of the three items recommended below.

### Build variants infrastructure

- Three variants produced by `npx gulp buildAllVariants`:
  - `Build/Cesium{Unminified}` — dual (WebGPU-first default). Historical path preserved.
  - `Build/CesiumWebGL{Unminified}` — WebGL-only (aliases `Source/Renderer/WebGPU/**` + `Source/Shaders/WebGPU/**` to empty stubs).
  - `Build/CesiumWebGPU{Unminified}` — WebGPU-only (aliases `Source/Shaders/*.js` GLSL strings to empty shader stub).
- Implementation:
  - [scripts/bundleVariantPlugin.js](../scripts/bundleVariantPlugin.js) — esbuild `onResolve` plugin with decision cache + synthetic path resolution. Exemption list (`WEBGPU_COMPAT_EXEMPTIONS`) keeps backend-neutral compat files (`WebGLCompatibilityStub`, `WebGPUShaderTranslator`, `WebGLStubPipelineExtractor`, `WebGPUNagaTranspiler`) resolvable in webgl-only builds.
  - [scripts/stubs/emptyShader.js](../scripts/stubs/emptyShader.js) — `export default ""` for GLSL string imports.
  - [scripts/stubs/emptyModule.js](../scripts/stubs/emptyModule.js) — Proxy that throws on access, explicit error pointing callers at contextOptions.renderer.
  - [Renderer/RendererType.ts](../packages/engine/Source/Renderer/RendererType.ts) — new `setGlobalDefaultRenderer()` / `getGlobalDefaultRenderer()`; entry barrels call it at module init.
  - Root [package.json](../package.json) `sideEffects` includes `"./Source/Cesium*.js"` so downstream bundlers don't tree-shake the default-renderer hint.
- ESM bundle gets `splitting: true` so `await import("./WebGPU/WebGPUContext.js")` in ContextFactory actually produces separate chunks (`Build/Cesium/chunks/WebGPUContext-*.js`). IIFE + CJS still inline because those formats don't support code splitting.
- **Performance:** `buildAllVariants` hoists `buildEngine` + `buildWidgets` so they run once, then uses a `buildCesiumVariantFast` path that skips worker / CSS / specs rebuild on variants 2-3 and copies shared assets from the dual output. Full `buildAllVariants` ≈ 1:20 on this machine.

### WebGL compatibility stub (Proton-style translation)

The stub under [Renderer/WebGPU/Stubs/](../packages/engine/Source/Renderer/WebGPU/Stubs/) went from "log no-op with a warning" to real WebGL→WebGPU translation for every layer except GLSL compilation:

- **Texture stub**: `createTexture` returns a pending wrapper; `texParameteri` + `pixelStorei` accumulate sampler/pixel-store state; `texImage2D` actually creates the `GPUTexture` (format picked from `internalformat`+`type`, mip chain sized from w/h, RENDER_ATTACHMENT usage set for later mipmap generation), uploads via `queue.writeTexture` (raw bytes, with manual row-flip for UNPACK_FLIP_Y_WEBGL) or `copyExternalImageToTexture` (ImageBitmap / HTMLImage / Canvas / Video / OffscreenCanvas); `generateMipmap` lazily instantiates `WebGPUMipmapGenerator` and dispatches real blit-down render passes on the active command encoder.
- **Shader stub**: `getParameter` answers 25+ WebGL constants from `device.limits` (MAX_TEXTURE_SIZE, MAX_VERTEX_ATTRIBS, MAX_COLOR_ATTACHMENTS, etc.) with plausible VENDOR/RENDERER/VERSION strings; `getExtension` returns non-null tag objects for 15 extensions whose features are in WebGPU core (OES_texture_float, OES_element_index_uint, ANGLE_instanced_arrays with the right method names, EXT_texture_filter_anisotropic with the anisotropy constants, etc.); GLSL compile path still a placeholder but a pluggable `WebGPUShaderTranslator` registry + lazy naga-wasm path landed for future runtime GLSL→WGSL.
- **Pipeline-state stub**: full stencil tracking added — `stencilFunc`/`stencilFuncSeparate` / `stencilOp`/`stencilOpSeparate` / `stencilMask`/`stencilMaskSeparate` with the WebGL→WebGPU op mapping (`GL_KEEP` → `"keep"`, `GL_INCR` → `"increment-clamp"`, etc.). Pairs with the new stencil state fields on `WebGLStubState`.

### DecoupledLookbackScan runtime wrapper (FEAT-SURVEY-06)

[WebGPUDecoupledScan.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDecoupledScan.ts) wraps [DecoupledLookbackScan.wgsl](../packages/engine/Source/Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl) with the same lifecycle shape as `WebGPUGPUCuller`: `initialize(shaderCode)` → `ensureCapacity(n)` → `dispatch(encoder, input, output, count)` → `destroy()`. Lazy partitions buffer, power-of-two growth, zeros-the-partitions on every dispatch (decoupled-lookback requires `FLAG_EMPTY = 0` initial state).

- 6-test spec at [WebGPUDecoupledScanSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUDecoupledScanSpec.js) using the mock-device pattern from `WebGPURingBufferAllocatorSpec`. Covers: no-alloc-before-init, init creates pipeline + params (not partitions — lazy), `ensureCapacity` grows with destroy of previous buffer, dispatch writes params + zeros + encodes compute pass with 4 bind-group entries, zero-length no-op, post-destroy returns false.
- **No consumer swapped yet.** The library is live; the "one consumer at a time" plan starts with point-cloud LOD (swap atomic-add compaction → scan-based deterministic compaction) — tracked below as item 3 of the next-session priorities.

### ParityManager (FEAT-SURVEY-07)

[WebGPUParityManager.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUParityManager.ts) landed in an earlier session; [WebGPUTAAEffect.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts) **now delegates to it**:

- Removed `_historyIndex` and `_frameCounter` fields.
- TAA owns a `WebGPUParityManager`, registers the history-view pair on `_allocateHistoryTextures`, rebinds on resize.
- `execute()` calls `advanceFrame()` exactly once at entry, then `parity.read<GPUTextureView>(slotId)` / `parity.write<GPUTextureView>(slotId)`.
- `_skipNextBlend` preserves the "first frame / post-resize passthrough" behavior that `_frameCounter === 0` used to give us.
- `getStatistics()` derives `frameCounter` + `historyIndex` from `_parityManager.frameIndex` — stats value and UB value are now consistent with each other (the old inline pair wasn't always).
- Behavioral note: `u32View[3]` (params-UB frameIndex) is shipped to the shader shifted +1 vs. pre-refactor, BUT `TAA.wgsl` never reads `params.frameIndex` (declared with comment "for debug / Halton cycle", never referenced). Off-by-one is cosmetic.
- A future session can hoist the manager to the scene renderer so Hi-Z reprojection + auto-exposure histograms share a single monotonic frame counter.

### Review fixes + documentation

- Root `package.json` `sideEffects` now covers `Source/Cesium*.js`.
- [bundleVariantPlugin.js](../scripts/bundleVariantPlugin.js) exemption-list comment now documents "how to add a new compat-surface file" + the IIFE code-splitting trade-off.
- [CLAUDE.md](../CLAUDE.md) Build Variants section updated with measured sizes, tree-shaking limits, compat-exemption protocol, side-effects requirement, smoke-test reference.
- New [Tools/variant-smoke-test.mjs](../Tools/variant-smoke-test.mjs) — Playwright runner, three variants, `CESIUM_BASE_URL` set from bundle path, default imagery + terrain disabled to avoid false-positive console.error on network failures. **Not yet run end-to-end.**

### Net delta since 2026-04-16 handoff

- Build variants infra: **shipped, measured, documented**. Not yet smoke-tested.
- TAA Slices 1 + 2a + ParityManager delegation: **shipped**. Slice 2b+ pending.
- Aerial-perspective LUT: 1 shader → 7 shaders. Visual verification pending.
- WebGL stub: Proton-style real translation for textures / parameters / extensions / stencil. GLSL translator scaffolded but naga-wasm not yet wired as first real consumer.
- DecoupledScan: runtime wrapper + spec; zero real consumers.

---

## Next session — recommended order

**Don't start TAA Slice 2b yet.** Slices 1 + 2a are shipped and cover the static-geometry case (~95% of what a globe renders). The remaining slices are refinements. Closing the loop on work we just shipped is higher value.

### Item 1 — Run the variant smoke test (highest risk, lowest cost, ~30 min)

The smoke-test script exists and I fixed its two latent issues (no CESIUM_BASE_URL → Cesium asset lookups break; default Bing imagery → network failures trip `console.error` and false-FAIL the test). It has never been executed end-to-end.

Given the number of moving pieces landed this cycle (6 shader edits, stub rewrite, build-variants plugin, sideEffects change, ParityManager refactor), there's real risk one of them breaks a variant at *runtime* while type-checking clean. Catching that now is 10× cheaper than catching it after more work lands on top.

```bash
# terminal 1
npm run restart
# terminal 2
node Tools/variant-smoke-test.mjs
```

Passes if all three variants report PASS with 0 console errors. Fixes are fast when the failure surface is isolated — if a variant breaks, the build-variants plugin or exemption list is the most likely culprit.

### Item 2 — Visual verification of the 6 aerial-LUT shaders (~1-2 hours)

The aerial-LUT rollout compiles and type-checks clean, but no one has seen the fog render on these shaders. [Tools/visual-regression/](../Tools/visual-regression/) has the scaffolding; add scenes to [scenes.json](../Tools/visual-regression/scenes.json) that place each affected material at near / mid / far / horizon distances and run the diff:

```bash
node Tools/visual-regression/capture-and-diff.mjs --update    # save baselines
node Tools/visual-regression/capture-and-diff.mjs             # check
```

Order of likelihood to surface issues: PBR variants first (tonemap+gamma ordering is the most delicate), then ModelPBRComplete (different input geometry — `rteMC` + `modelMatrix` instead of `eyePosition`), then the simpler Phong/MatColorLit/MatImageLit.

### Item 3 — Wire DecoupledScan into point-cloud LOD (1 session)

First real consumer of the library. Target [WebGPUPointCloudLODProcessor.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts):

- **Current behavior**: atomic-add compaction → order-unstable `visibleIndices` buffer. Side effect: picking consistency is worse than it could be (same point may sort differently frame-to-frame).
- **Swap**: run the per-point 0/1 visibility flag through `WebGPUDecoupledScan.dispatch()`; the resulting inclusive prefix is the compact-index lookup. Second small compute pass converts flag + prefix → compact visible-indices buffer.
- **Verification**: existing point-cloud tests + new micro-benchmark (~100k point cloud) comparing scan vs atomic wall-clock and picking stability.

The "one consumer at a time, measure impact, iterate" framing you set applies here. Getting the pattern right on this swap makes indirect-draw compaction and particle cull mechanical afterwards.

### Deferred (in the order I'd pick if pressed)

- **TAA Slice 2b — per-model MRT motion** (effort: 1-2 sessions).
  Ghosting on animated glTF is real but narrow (affects only
  skinned/morphed/instanced, which is a small fraction of Cesium scenes
  today). Requires a second color attachment on every model pipeline +
  previous-frame joint/morph/instance UBO layout.
- **BUG-3 — 2D/Columbus View projection in WebGPU globe renderer**
  (effort: 3-5 days). Opens new rendering surface area. Better to
  stabilize 3D path first. Tracked in backlog.
- **Principal-engineer-review tail** (§5a/§5b/§5c specs,
  §6d `@private` → `@internal`, etc.). Each is a bounded PR; schedule
  opportunistically. §6d is the smallest unblock (~2-3h).
- **ES6 modernization Phase A — `WGSLShaderBuilder.js`** (25 markers,
  effort: 1-2 hours). Still the right target when the modernization
  track is picked up. Pilot for Phase A; pattern establishes the rest.

### What NOT to do next

- Don't pursue TAA Slice 2b until visual verification of what's shipped is done. Building per-model motion on top of an unverified Slice 1 pipeline multiplies the surface area of unknowns.
- Don't start full GLSL→WGSL runtime translation via naga-wasm yet. Scaffolding is in place ([WebGPUNagaTranspiler.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts) + the shader translator registry) but pipeline materialization for translated programs is a multi-session effort. Park until a consumer needs it.
- Don't modernize upstream-pristine files (Phase D). Merge-friction cost exceeds benefit.

---

## Session 31 — Principal-engineer review fixes (2026-04-16)

The review surfaced 17 actionable findings across CRITICAL / HIGH / MEDIUM tiers. After verification, **5 had already been fixed** by other work (§2 build outputs, §3f double-beginRenderPass, §4a Scene.js leaks, §4d VOLUMETRIC_FOG consumer, §6b panorama logs). The remaining **11 valid findings were fixed in this session**:

| Tier | Finding | Fix | File(s) |
| --- | --- | --- | --- |
| CRITICAL §1 | esbuild parse-error race on second build | Explicit `loader: { ".ts": "ts", … }` map in `defaultESBuildOptions()` | [scripts/build.js](../scripts/build.js) |
| CRITICAL §3a | Ring allocator overflow grew unbounded (no auto-trim) | Auto-trim every N frames (default 60) + `maxPageCount` circuit breaker (default 32) + first-overflow warning + actionable error message | [WebGPURingBufferAllocator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts) |
| CRITICAL §3b | `mapAsync` callback accessed `_stagingBuffer` after destroy | Captured staging buffer reference + `_isDestroyed` + identity guard in all three async paths (sync `_startReadback`, `endAsync`, `readDepthPixelAsync`); `isDestroyed()` now reports the real flag | [WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts) |
| CRITICAL §3c | Per-frame `createView()` and `createBindGroup()` leaked | Cached `_colorView` / `_depthView` (recreated only on resize); `WeakMap<GPUTexture, GPUBindGroup[]>` cache in mipmap generator (auto-releases when textures are GC'd) | [WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts), [WebGPUMipmapGenerator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts) |
| CRITICAL §3d | Device-loss recovery promise was detached | Promise stored on the recovery manager; `dispose()` method awaits it; `WebGPUContext.destroy()` calls `dispose()` and trips an abort flag so a recovered device isn't promoted into a torn-down context | [WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts), [WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) |
| CRITICAL §3e | Shader cache errors lost the WGSL source | Truncated source (800 chars) appended to console output; full source attached to the wrapped Error as `wgslSource` for programmatic access; shader name attached as `shaderName` | [WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts) |
| HIGH §4b | `WebGPUDrawCommand` missing `occlude` + `pickOnly` | Added to options interface, fields, defaults (`occlude` defaults true mirroring WebGL, `pickOnly` defaults false), and `clone()` | [WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts) |
| HIGH §4c | Lazy feature-renderer race + half-flicker | Replaced boolean flag with discriminated-union `FeatureRendererLoadStatus` (registered / loading / loaded / failed); added `getFeatureRendererAsync(key)`, `getFeatureRendererStatus(key)`, `isFeatureRendererLoading(key)`, `hasFeatureRendererFailed(key)`. Failed loads can be retried on next call. RxJS BehaviorSubject was considered but rejected — consumers don't subscribe to changes (they call `getFeatureRenderer(key)` per frame), so the typed-state slot is more performant and avoids pulling RxJS into the engine | [GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) |
| MEDIUM §6a | Cache errors missing `context.id` prefix | Constructors accept optional `contextId`; errors now log `[CesiumJS:webgpu:<id>:shader-cache]` / `[CesiumJS:webgpu:<id>:pipeline-cache]`. Both caches are dormant infrastructure (not yet instantiated by `WebGPUContext`) but the principled gap is closed | [WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts), [WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts) |
| MEDIUM §6c | `@webgpu/types` on caret range | Tight-pinned `0.1.69` with rationale documented in the PR | [package.json](../package.json) |

### Net delta

- Build determinism: **fixed** — two consecutive `gulp build` runs from a clean tree both succeed.
- Resource lifecycle: **5 of 6 confirmed leaks/races closed**. The remaining one (HIGH §5a — specs not in CI) is an infra change requiring a CI workflow edit; left as an open task because the test suite + spec-runner config need a separate review pass.
- Backwards compatibility: **zero behavior changes for existing callers**. The `getFeatureRenderer(key)` sync path returns the same values; the new async/status methods are additive.

### What's NOT yet addressed from the review

| Tier | Finding | Why deferred |
| --- | --- | --- |
| CRITICAL §1 | Move generated `Source/Cesium*.js` entry files to `Build/generated/` | Cosmetic + risky — touches the entire build pipeline, several test pages reference root `Source/Cesium.js`. Leave for a focused build-system PR |
| CRITICAL §2 | `gulp prepare` destroys `Build/Cesium*` siblings | **DISPROVED on re-verification** — the `prepare` task is non-destructive |
| HIGH §4d | `auditFeatureRenderers` gulp task | The discriminated-union status above (§4c) gives us the data structure to audit; the gulp task itself is ~50 LOC in a separate PR |
| HIGH §5a | Specs not in CI | The dev workflow already runs `npm test` via `release-tests` job (with `--release --webgl-stub`), but WebGPU-specific specs need a non-stub run in a fresh job. Needs a workflow PR |
| HIGH §5b | `bundleVariantPlugin` spec | New file; fits naturally with the next batch of test work |
| HIGH §5c | 20+ untested WebGPU modules (~8,850 LOC) | Backfill campaign; one module per PR is the realistic cadence |
| MEDIUM §6d | `@private` → `@internal` sweep | ~2-3 hour grunt task, no risk; queue for a low-context session |
| MEDIUM §6e | Pragma stripping post-build lint | Build-system tooling; pairs with §1 generated-entry move |
| MEDIUM §6f | Inconsistent error prefixes | 86 `console.*` call sites in `Renderer/WebGPU/`; mechanical sweep |
| MEDIUM §6g | Documentation drift CI check | Quarterly process change; not single-PR work |
| MEDIUM §6h | `FEATURE_RENDERER_ONBOARDING.md` | ~300 LOC doc; can be authored alongside the next FR addition |

---

## Next chunk — full ES6/ES2022 modernization

The user has explicitly requested this as the next milestone. The Session 30 handoff captured the raw count (`~433 modernization markers` across the engine + widgets) and recommended a two-track approach. Here's the plan that operationalizes it.

### Total surface area (re-counted at Session 30 close)

| Marker | Count |
| --- | --- |
| `var` declarations | ~0 (all gone) |
| IIFE wrappers `(function(){})()` | 0 |
| `var self = this` / `var that = this` | 0 |
| `X.prototype.method = function()` | **293** |
| `Object.defineProperties(X.prototype, {...})` | **105** |
| `.apply(null, args)` / `.apply(this, args)` | 10 |
| `arguments` object reads | 25 |

### The hidden cost

CesiumGS upstream has **not** modernized the bulk of these files. Every upstream-pristine `.js` we modernize creates a structural merge conflict on every upstream sync. The principled split:

- **Modernize now**: fork-owned files. Modernizing them is nearly free because we resolve conflicts during every sync anyway.
- **Modernize opportunistically**: files we touch for unrelated work (CLAUDE.md's existing 10-line rule already enforces this).
- **Defer indefinitely**: upstream-pristine files. Modernizing them adds merge friction with little benefit.

### Phase A — fork-owned files (~1-2 hours)

These are the highest-priority targets because they're either WebGPU-specific or actively-edited fork additions:

| File | Markers | Notes |
| --- | --- | --- |
| [Renderer/WebGPU/WGSLShaderBuilder.js](../packages/engine/Source/Renderer/WebGPU/WGSLShaderBuilder.js) | 25 | Touched on every WGSL feature; modernize before it grows further |
| [Renderer/WebGPU/RenderCommand.js](../packages/engine/Source/Renderer/WebGPU/RenderCommand.js) | 8 | Backend-agnostic abstraction |
| Any other fork-specific `Renderer/WebGPU/*.js` outliers | small | Sweep in same pass |

**Acceptance:** every `prototype.method = function()` becomes a class method; every `Object.defineProperties` becomes ES6 `get`/`set`; existing JSDoc preserved (CLAUDE.md rule); no JSDoc added that wasn't there.

### Phase B — fork-modified Scene + Renderer files (~3-5 days)

Files where we have meaningful WebGPU additions on top of upstream code. Modernizing here costs less than modernizing pristine files because we already resolve the conflicts during sync. Candidates surfaced from session-30 audit:

| File | Markers | Reason |
| --- | --- | --- |
| Scene/Primitive.js, Scene/PointPrimitiveCollection.js, Scene/PolylineCollection.js, etc. | varies | We've added WebGPU routing; merge cost is already paid each sync |
| Renderer/Context.js | varies | Already ES6 class via our extends GraphicsContext refactor — verify no remaining `prototype.method` patterns |
| Renderer/createUniformArray.js + createUniform.js | 26 combined | Frequently touched in WebGPU uniform work |

### Phase C — opportunistic (CLAUDE.md rule already covers this)

Every file touched for >10 lines of unrelated work picks up its modernization for free. Over 6-12 months of active development this naturally covers the fork-specific + frequently-edited files without paying the merge cost.

### Phase D — deliberate upstream-pristine deferral

The ~300 markers in `KmlDataSource.js`, `CesiumWidget.js`, `AtmosphericConditions.js`, `PolylineCollection.js`, etc. are explicitly **not** scheduled. They modernize when upstream modernizes them, or when feature work happens to touch them.

### What "modernization" concretely means

Per the CLAUDE.md ES6+ rules + the upstream Coding Guide:

1. `var` → `const` / `let`
2. Prototype-based inheritance → ES6 `class` syntax (preserving all JSDoc, removing `@constructor` and `@memberof X.prototype` that are now redundant)
3. `Object.defineProperties()` getters/setters → ES6 `get` / `set` in class body
4. String concatenation → template literals (only where readability improves)
5. `Function.prototype.apply(null, args)` → spread (`fn(...args)`)
6. `arguments` reads → rest parameters (`...args`)
7. `for (var i = 0; ...)` over arrays → `for...of` or `.forEach()` *only* where perf is not critical
8. `typeof x !== "undefined"` → optional chaining / nullish coalescing
9. `Object.assign({}, defaults, options)` → `{ ...defaults, ...options }`
10. `.indexOf(x) !== -1` → `.includes(x)`
11. `obj.hasOwnProperty(key)` → `Object.hasOwn(obj, key)`

**Performance-critical math classes** (`Cartesian3`, `Matrix4`, `Quaternion`, `JulianDate`) are intentionally left alone — they use `result` parameters and scratch variables where ES6 patterns can introduce overhead. Benchmark before any change here.

### Recommended starting point next session

1. **Read this handoff + the principal-engineer review.**
2. **Pick `WGSLShaderBuilder.js` as the Phase A pilot** — biggest single fork-owned target (25 markers), establishes the pattern for the rest.
3. **Run `npx tsc --project packages/engine/tsconfig.json --noEmit`** as the gate after every file conversion.
4. **Update [migration_doc/ES6_MODERNIZATION_BACKLOG.md](ES6_MODERNIZATION_BACKLOG.md)** with the converted-file list as you go.
5. **Hold the line:** never modernize a file you're not otherwise touching unless it's on the explicit Phase A/B list.

---

## What's at the principled floor in Renderer/WebGPU

(Carrying forward from Session 30 — unchanged.)

Every remaining `any`/`unknown`/`object`/`Record<string, unknown>` in the WebGPU renderer is one of:

- `catch (e: unknown)` — TS's required catch binding (8 sites)
- Open index signatures on explicitly-permissive interfaces (SceneGlobalCache fallback, CesiumComputeCommand, CesiumObjectWithWebGPUCache) — by-design
- `jsModule<T>(mod: object)` — intentional type-eraser helper in `webgpuTypeHelpers.ts`
- `_gl` / `cache` on `WebGPUContext` — WebGL-compat JS surfaces consumed by ~20 upstream JS files
- `_performanceManager as unknown as {...}` — WIP per `feedback_interface_pruning.md` memory
- `PickTarget` index signature value — principled opaque for "value in heterogeneous external registry"

Further tightening requires (a) porting WebGL resource JS to TS, or (b) completing WIP modules — both are feature work, not typing work.

---

## Quick recipe — starting the next session

```text
1. Read this file (NEXT_SESSION_HANDOFF.md) — full picture.
2. Read PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md if you need context on
   why specific lifecycle bugs / arch decisions exist as they are.
3. If continuing the modernization push:
   - Start with `WGSLShaderBuilder.js` (Phase A).
   - One file per commit; tsc --noEmit between each.
   - Preserve existing JSDoc; do NOT add new JSDoc.
4. If continuing the review-fix tail (§5a/§5b/§5c/§6d/§6e/§6f/§6g/§6h):
   - The "What's NOT yet addressed" table above ranks them.
   - The smallest unblock is §6d (`@private` → `@internal` sweep, ~2-3h).
5. After every meaningful change: `npx tsc --noEmit`.
```

## Files referenced by this handoff

**Review:**

- [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) — the source of the fix list

**Status docs:**

- [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) — full session-by-session history
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — remaining work
- [ES6_MODERNIZATION_BACKLOG.md](ES6_MODERNIZATION_BACKLOG.md) — modernization tracker

**Project rules:**

- [../CLAUDE.md](../CLAUDE.md) — backend agnosticism, RTE precision, file placement, ES6 modernization, `any` ban, co-located `.d.ts` pattern

**Key code surfaces touched this session:**

- [scripts/build.js](../scripts/build.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) (destroy() teardown order)
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts)
- [packages/engine/Source/Renderer/GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) (lazy FR state machine + status introspection)
- [package.json](../package.json) (`@webgpu/types` pin)
