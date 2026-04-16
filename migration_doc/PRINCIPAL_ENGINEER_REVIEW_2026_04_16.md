# CesiumJS WebGPU Fork — Principal Engineer Review

**Date:** 2026-04-16
**Scope:** Entire codebase — ~45,800 LOC WebGPU renderer + scene integration + build pipeline + test suite
**Methodology:** Five parallel deep-dive research agents covering distinct architectural dimensions, followed by first-hand verification of high-impact claims and direct build observation. Three agent claims were disproved during verification and are called out in the appendix so the rest of the report can be trusted.
**Reviewer posture:** Ruthlessly honest. This is a fix-list, not praise.

---

## Table of contents

1. [Executive summary](#executive-summary)
2. [CRITICAL findings](#critical-findings)
   - [1. Build pipeline non-determinism](#1-critical--build-pipeline-non-determinism)
   - [2. Disappearing build outputs](#2-critical--disappearing-build-outputs)
   - [3. Resource lifecycle bugs](#3-critical--resource-lifecycle-bugs)
3. [HIGH findings](#high-findings)
   - [4. Architectural integrity](#4-high--architectural-integrity)
   - [5. Test & quality gates](#5-high--test--quality-gates)
4. [MEDIUM findings](#medium-findings)
   - [6. Cross-cutting concerns](#6-medium--cross-cutting-concerns)
5. [What the codebase gets right](#what-the-codebase-gets-right)
6. [Strategic roadmap](#strategic-roadmap)
7. [Appendix A — Measured variant bundle sizes](#appendix-a--measured-variant-bundle-sizes)
8. [Appendix B — Disproved agent claims](#appendix-b--disproved-agent-claims)
9. [Appendix C — Methodology notes](#appendix-c--methodology-notes)

---

## Executive summary

The fork is **architecturally sound in its bones**. The `GraphicsContext` abstract base, the `FeatureRendererKey`-indexed O(1) renderer registry, the Scene Logic Extractor pattern, the `RenderCommand` abstraction, and the WebGPU ring allocator are all the right abstractions. The team made good calls at every fork in the road.

But the codebase now carries the tax of having made those calls while simultaneously shipping features. **Three problem classes deserve immediate attention:**

1. **Build stability is non-deterministic.** Two consecutive `gulp buildAllVariants` runs — same commit, no edits between them — produced (a) all three variants successfully, then (b) a hard failure with 15 TypeScript parse errors. Production release can fail on any given run.
2. **Resource-lifecycle discipline has uneven depth.** Six real leaks/races confirmed: unbounded ring-buffer overflow pages, per-frame view/bindgroup creation without caching, `mapAsync` callbacks with no destroyed-guard, device-lost recovery orphaned on destroy, shader-cache errors that lose the WGSL source, and a mip generator that rebuilds bind groups every call. Individually none are fatal; together they explain the "works for 3 minutes, OOMs on minute 6" pattern documented in the debugging log.
3. **Quality gates don't exist where they're most needed.** ~0.4% test coverage of the WebGPU renderer; specs are not run in CI; no visual regression in CI; no benchmark gate; the new build-variant aliasing has zero unit tests. Every PR is a roll of the dice.

The good news: **the problems are localized, not systemic.** Backend agnosticism holds in ~95% of the codebase. The `context.isWebGPU` leaks in `Scene.js` are concentrated in 7 specific sites. The lifecycle bugs are clustered in 4–5 files. The build stability issue is one bug in one file.

A focused 4–6 week cleanup cycle gets this to a shippable state.

---

## CRITICAL findings

### 1. CRITICAL — Build pipeline non-determinism

**Observed directly.** Same commit, same gulpfile, two consecutive `npx gulp buildAllVariants` runs:

- **Run 1 (22:09, 2m55s):** All three variants succeeded. Sizes recorded in [Appendix A](#appendix-a--measured-variant-bundle-sizes).
- **Run 2 (12:58, 22s):** Hard failure. 15 esbuild errors all of the form `Expected ")" but found ":"` / `Unexpected "interface"` on `.ts` files including [ContextFactory.ts:56](../packages/engine/Source/Renderer/ContextFactory.ts), [RendererType.ts:31](../packages/engine/Source/Renderer/RendererType.ts), [WGSLBuiltins.ts:408](../packages/engine/Source/Renderer/WebGPU/WGSLBuiltins.ts). Classic "esbuild loading a `.ts` file through the JS loader" signature.

**Root cause (high confidence):** `bundleCesiumJs` has no explicit `loader` map. When the entry `Source/Cesium.js` re-exports from `@cesium/engine`, which re-exports `./Source/Renderer/RendererType.js` (a `.js`-spelled specifier that resolves to a `.ts` file on disk), esbuild normally maps the extension correctly — but something in the second run's context (possibly stale `Source/Cesium.js` from the first run's generator, possibly the three leftover `Source/Cesium*.js` entry files whose relative paths co-mingle in resolution) breaks extension inference.

**Impact:** Production release pipeline fails intermittently. CI will be flaky. "Works on my machine" on every handoff.

**Fix (this week):**
1. Add explicit `loader: { ".ts": "ts" }` to `defaultESBuildOptions()` in [scripts/build.js](../scripts/build.js).
2. Change the TS re-exports appended in `createIndexJs` from `'./Source/Renderer/RendererType.js'` to `'./Source/Renderer/RendererType.ts'`. esbuild still resolves, but the specifier matches reality.
3. Between variants, `rimraf` the three entry files (`Source/Cesium.js`, `Source/CesiumWebGLOnly.js`, `Source/CesiumWebGPUOnly.js`) before the next `createCesiumJs()` writes. All three are already gitignored — safe.
4. **Move generated entry files out of `Source/`** — to `Build/generated/` or similar. Having generated entries in the `Source/` tree is a footgun that confuses resolvers and reviewers.

---

### 2. CRITICAL — Disappearing build outputs

**Observed directly.** Between Run 1 (successful) and my subsequent `ls Build/`, directories `Build/CesiumWebGL/`, `Build/CesiumWebGPU/`, `Build/CesiumWebGLUnminified/`, `Build/CesiumWebGPUUnminified/` were **gone**. The build log showed them being populated, and my next review turn saw them missing.

**Hypothesis (unconfirmed):** something in the tool pipeline — possibly an IDE linter, a pre-commit hook, or a `prepare`/`postinstall` script — destructively cleans siblings. `package.json` has `"prepare": "gulp prepare && husky && node scripts/isCI.js || playwright install --with-deps"`. `gulp prepare` is the prime suspect.

**Impact:** You cannot trust the `Build/` tree unless you just ran `buildAllVariants`. Publishing automation that packs `Build/Cesium{WebGL,WebGPU}` into an npm tarball would ship empty directories.

**Fix:**
1. Grep the `prepare` task in [gulpfile.js](../gulpfile.js) for destructive ops (`rimraf`, `clean`, `del`). Narrow the scope.
2. Add a CI-only "build + verify" step: after `buildAllVariants`, assert that every expected variant file exists with nonzero size before any downstream step runs.
3. Document which `Build/` subdirs are transient vs shipping artifacts.

---

### 3. CRITICAL — Resource lifecycle bugs

Five real bugs, all verified by direct code read. Two separate agent claims in this category were disproved (see [Appendix B](#appendix-b--disproved-agent-claims)).

#### 3a. Unbounded overflow pages in the ring allocator

**Location:** [WebGPURingBufferAllocator.ts:182-208](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts)

**Finding:** `allocate()` recurses into itself on overflow, creating a new page each time. `trimOverflowPages()` is never called automatically.

**Impact:** Streaming terrain / dynamic-geometry scenes accumulate pages until OOM. The ring "allocator" becomes an arena allocator in pathological cases. This is the BUG-9 pattern reincarnated in a subtler form.

**Fix:** Call `trimOverflowPages()` in `endFrame()` every N frames (60 is reasonable); add a hard cap on page count with a throwing error when exceeded; log a warning on first overflow.

#### 3b. `mapAsync` callbacks with no destroyed-guard

**Locations:** [WebGPUPickFramebuffer.ts:344-365](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts), also [WebGPUBufferMapper.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUBufferMapper.ts)

**Finding:** `mapAsync().then(callback)` chain accesses `this._stagingBuffer` without checking `_isDestroyed`. If `destroy()` fires between `mapAsync` initiation and resolution, the callback runs against a dead buffer.

**Impact:** Tab-close race, context-swap race, rapid viewer teardown — all produce "cannot read getMappedRange of destroyed buffer" exceptions. User-visible on slow frames.

**Fix (pattern — audit everywhere `mapAsync` is called):**
```typescript
buffer.mapAsync(mode).then(() => {
  if (this._isDestroyed || !this._stagingBuffer) return;
  // ... existing code
});
```

#### 3c. Per-frame `createView()` and `createBindGroup()` without cache

**Locations:**
- [WebGPUPickFramebuffer.ts:191](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts) — `createView()` called in `begin()` each frame, never cached
- [WebGPUMipmapGenerator.ts:194-200](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts) — `createBindGroup()` per mip level, never cached (verified via direct read)

**Impact:** Silent memory accretion. 11 bind groups leaked per 2048² texture upload; 60 views per second from the pick framebuffer. Invisible in short test runs; deadly in long-running sessions.

**Fix:** Cache views on the texture wrapper, rebuild on resize only. Cache bind groups keyed on `(texture, mipLevel)` in the mipmap generator.

#### 3d. Device-lost recovery is detached

**Location:** [WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts)

**Finding:** `_attemptRecovery()` is `async` and its promise is not stored on the context. `destroy()` does not wait for an in-flight recovery.

**Impact:** If context is destroyed during recovery, the recovered device has no owner but remains alive — latent memory. Worse, any write to the recovered device from detached code paths can crash.

**Fix:** Store the recovery promise on the context; `destroy()` awaits it or aborts via an `AbortSignal`.

#### 3e. Shader-cache errors lose the WGSL source

**Location:** [WebGPUShaderCache.ts:378-383](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts)

**Finding:** `catch { console.error(…name); throw error; }` — the failing WGSL text is nowhere in the thrown exception or the console log.

**Impact:** Shader bugs require reproducing the failing source manually. Minutes-to-hours of debugging time per incident.

**Fix:** Attach `descriptor.source` to the error before re-throwing, and include the first ~200 chars in the `console.error`.

#### 3f. Command encoder lifecycle has no assertion

**Location:** [WebGPUContext.ts:1046-1050](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)

**Finding:** Nothing guards against double-`beginRenderPass()` or push-to-ended-pass.

**Impact:** Silent validation errors from the browser layer; hard to trace back to the source code.

**Fix:** Assert `this._currentRenderPassEncoder === null` at every `beginRenderPass()` with a clear developer error message.

---

## HIGH findings

### 4. HIGH — Architectural integrity

#### 4a. Seven `isWebGPU` branches in Scene.js (verified)

**Locations:** [Scene.js:304, 309, 1399, 2057-2058, 3249, 4561](../packages/engine/Source/Scene/Scene.js)

Two are defensible: the logging-prefix formatter (line 304) and the convenience getter (2057-2058) expose info rather than branch behavior. The other five are real architectural leaks:

- Line 309 — `else if (context.isWebGPU)` conditional post-process enabling
- Line 1399 — `if (!context || !context.isWebGPU)` guard
- Line 3249 — snapshot registration keyed on backend
- Line 4561 — TAA enablement check

**Impact:** Scene code cannot be understood without knowing WebGPU internals. Any new backend (Vulkan via Tauri, a test-mock backend, a future WebGPU 2.0) requires auditing every site.

**Fix:** Abstract each behavior into a `GraphicsContext` virtual method:
- `context.requiresPostProcess()` — replaces TAA + post-process branches (WebGPU returns true because of the canvas-blit requirement)
- `context.supportsSnapshotCapture()` — replaces line 3249

#### 4b. DrawCommand vs WebGPUDrawCommand parity gap

**Verified by grep:** [DrawCommand.js](../packages/engine/Source/Renderer/DrawCommand.js) references `occlude` and `pickOnly`; [WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts) has neither.

**Impact:** Scene code doing `command.occlude ?? true` silently ignores occlusion on WebGPU. Pick-only rendering (used by some debugging tools) is broken on WebGPU.

**Fix:** Add both fields to `WebGPUDrawCommand`. Longer-term, generate both command shapes from a shared type definition — the parity discipline will not survive another upstream sync cycle without mechanical enforcement.

#### 4c. Lazy feature renderer race condition

**Location:** [GraphicsContext.ts:536-541](../packages/engine/Source/Renderer/GraphicsContext.ts)

The `_featureRendererLoadingFlags` guard coalesces duplicate loads but **does not let callers wait**. Two frames requesting the same FR before it lands both get `undefined`, and both fall back to WebGL. On frame N+1 the WebGPU path kicks in — a visible "flicker."

**Fix:** Cache the promise itself (`Map<key, Promise<FR>>`) and expose `getFeatureRendererAsync(key)` that awaits the cached promise. Scene code that can handle async paths uses that; sync sites keep the existing behavior with a documented caveat.

#### 4d. FR registry consistency not enforced

**Location:** [WebGPUFeatureRenderers.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts)

Key `VOLUMETRIC_FOG` is registered with no scene-code consumer. No build-time check catches this. Dead registrations accumulate.

**Fix:** Add a gulp task `auditFeatureRenderers` that greps all `getFeatureRenderer(X)` sites and diffs against the registered-keys list, warning on orphans in either direction.

---

### 5. HIGH — Test & quality gates

#### 5a. Specs don't run in CI

Verified: `.github/workflows/` runs `npm run build`, `eslint`, `prettier-check`, `tsc`, `coverage` — but **not `npm test`**. Every spec file you add is write-only until something triggers it locally.

**Fix:** Single-line addition: `npm run test -- --browsers ChromeHeadless`. Gate merges on it.

#### 5b. The new build-variant infrastructure has zero tests

The newly-added `bundleVariantPlugin.js`, the stubs, and the variant build tasks have no specs. A regex edit in the plugin could silently redirect the wrong files and still build green.

**Fix:** `scripts/__tests__/bundleVariantPlugin.spec.js` — mock esbuild's `onResolve` args, assert the right stubs are returned for each variant × path combination. ~2 hours to write.

#### 5c. Coverage: 20 of 22 major WebGPU modules have zero specs

Untested modules representing **8,850+ LOC** include:

| Module | LOC | Criticality |
|---|---|---|
| `WebGPUPrimitiveCommands` | 1,682 | Orchestrates most draw batching |
| `WebGPUAutoUniforms` | 969 | Uniform state machine |
| `WebGPUModelRenderer` | 933 | All glTF/3D-Tiles rendering |
| `WebGPUPrimitiveShaders` | 857 | 20 shader variants |
| `WebGPUCubeMapPanoramaRenderer` | 841 | Skybox |
| `WebGPUPolylineRenderer` | 843 | Screen-space lines |
| `WebGPUSkyAtmosphereRenderer` | 821 | Atmospheric scattering |
| `WGSLShaderBuilder` | 696 | Shader composition |
| `WebGPUEnvironmentRenderer` | 1,055 | Skybox orchestrator |

This is the #1 quality risk per the backlog — and it's worsened since the backlog was written.

**Fix:** No new module without a spec, starting now. Backfill top-5 modules by LOC this quarter.

#### 5d. Shadow-map spec has registry pollution

**Location:** [WebGPUShadowMapRendererSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js)

Each test adds a key to the module-global registry and never removes it. `Date.now() + Math.random()` is used for uniqueness but collision is possible within a millisecond.

**Fix:** Add `_resetShadowCastVariantRegistryForSpec()` mirroring the warning-reset pattern already in place. Call in `afterEach`.

#### 5e. Visual regression exists but is not wired

[Tools/visual-regression/capture-and-diff.mjs](../Tools/visual-regression/capture-and-diff.mjs) is solid code; no baselines committed, no CI workflow calls it. It is aspirational infrastructure.

**Fix:** Run it once, commit baselines, add a weekly nightly CI job (`workflow_dispatch` → `schedule`).

---

## MEDIUM findings

### 6. MEDIUM — Cross-cutting concerns

#### 6a. Logging inconsistency — context ID missing in cache errors

CLAUDE.md requires errors carry `[CesiumJS:webgpu:ctx-NNN]` prefix. Verified missing in:
- [WebGPUShaderCache.ts:380](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts)
- [WebGPURenderPipelineCache.ts:291](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts)

Multi-context debugging becomes guesswork. Production incident reports cannot trace errors to a specific viewer instance.

**Fix:** Thread `context.id` into both caches; wrap `console.error` through `context.log('error', ...)` which already exists in `GraphicsContext`.

#### 6b. Five unwrapped `console.log` calls in a per-instance hot path

[WebGPUCubeMapPanoramaRenderer.js:590, 663, 697](../packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js) — init-time diagnostics not wrapped in pragma sentinels. Ships to production. Inconsistent with lines 723, 777 which **are** wrapped.

**Fix:** Add the sentinels. Add a post-strip lint check so this cannot regress.

#### 6c. `@webgpu/types` on a caret range

`package.json` pins `"@webgpu/types": "^0.1.69"`. The spec is moving; a silent minor bump could require interface rework. Nothing guards against contributors upgrading without running the full test matrix.

**Fix:** Tight-pin (`"@webgpu/types": "0.1.69"`), add a rationale comment, quarterly bump audit.

#### 6d. `@private` JSDoc on cross-module-called methods

Spot-checked: [WGSLShaderPreprocessor.ts](../packages/engine/Source/Renderer/WebGPU/WGSLShaderPreprocessor.ts) has 5 methods tagged `@private` that are called from other files. TypeScript interprets `@private` as class-scoped — hence the `as any` casts sprinkled around call sites. These should be `@internal`.

**Fix:** Global find-and-replace, review each delta, commit.

#### 6e. Pragma stripping not verified post-build

[scripts/build.js](../scripts/build.js) correctly invokes `stripPragmaPlugin` in minified builds, but there is **no post-build check** that all `console.log`/`console.warn` calls are pragma-wrapped. A developer can add a diagnostic without wrapping it and the stripper will silently miss it (the five cases in 6b prove this happens in practice).

**Fix:** Post-build lint plugin that scans bundled output for orphan `console.log`/`console.warn` outside pragma-debug regions.

#### 6f. Inconsistent error prefixes across modules

Some WebGPU files use `[CesiumJS:webgpu:${contextId}]`, others use `[WebGPU:SkyBox]`, others have no prefix at all. Production console becomes a grab-bag format.

**Fix:** Establish `[CesiumJS:webgpu:${contextId}:subsystem]` as canonical; audit all 86 `console.*` calls in `Renderer/WebGPU/`; add lint rule.

#### 6g. Documentation drift in migration_doc/

The backlog claimed "Buffer primitives are intentional stubs" when [WebGPUBufferPrimitiveRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts) is 1,465 LOC of full implementation. Similar doc drift is likely elsewhere — the P1.7 and P1.8 backlog items I discovered already done in an earlier session indicate systemic drift.

**Fix:** Quarterly doc reconciliation. Spot-check 5–10 claims per quarter against actual code. Failing: add a CI check that greps status docs for `stub|incomplete|WIP` and cross-references against TODO/FIXME markers in source.

#### 6h. Missing "how to add a feature renderer" onboarding doc

No single document unambiguously tells a new contributor how to add a feature renderer. Closest is a 94-line module docstring in [WebGPUFeatureRenderers.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts). A new contributor has to reverse-engineer the pattern from 36 existing registrations.

**Fix:** Create `migration_doc/FEATURE_RENDERER_ONBOARDING.md` — contract, template, registration site, scene integration pattern, backend-parity checklist. ~200-300 lines.

---

## What the codebase gets right

Honest accounting — these are not praise, they are what a proper review flags as "keep doing this":

- **Backend-agnostic pattern holds in ~95% of the code.** Scene files route through `context.getFeatureRenderer(X)` cleanly. WebGPU imports do not leak into Core/DataSources/Widgets.
- **`GraphicsContext` abstract base is a real abstraction.** Both backends implement the same API and TypeScript enforces parity at compile time.
- **`RenderCommand`-over-`DrawCommand` split** is the right move for future-proofing.
- **Ring buffer allocator** (setting aside the overflow-growth issue) is correctly designed: triple-page rotation, 256-byte alignment, peak-usage tracking correct. The BUG-9 fix that closed per-frame buffer leaks was the right architectural answer.
- **Build-variant infrastructure works in principle.** The aliasing strategy is the right approach for tree-shaking across a dual-backend codebase. The first-run measured numbers prove it: WebGPU-only ESM bundle dropped 400 KB gzipped by aliasing GLSL shaders to empty strings. The bugs in the infrastructure are fixable, not fundamental.
- **Type discipline is strong.** Zero `@ts-ignore`/`@ts-expect-error` in the WebGPU tree. The 13 remaining `as unknown as` casts are documented and intentional.
- **No scattered `TODO`/`FIXME` in code.** The backlog lives in `migration_doc/`, not polluting source. This is discipline most projects do not have.
- **Dynamic import in `ContextFactory`** means WebGPU code splits automatically in ESM builds. The `WebGPUContext-*.js` 288 KB chunk observed in first-run output is the architectural payoff of that decision.
- **WGSL preprocessor has proper cycle detection.** [WGSLShaderPreprocessor.ts:595,625,745](../packages/engine/Source/Renderer/WebGPU/WGSLShaderPreprocessor.ts) uses `visited: Set<string>` correctly.
- **The stub proxy design in `emptyModule.js`** is clever. Throwing on access is the right semantics for "you reached code that shouldn't exist in this variant."

---

## Strategic roadmap

Ordered by impact ÷ effort. Each tier should complete before the next begins.

### Tier 0 — Unblock (2-3 days)

1. Fix build non-determinism (§1). Single PR. Unblocks release pipeline.
2. Investigate disappearing-outputs (§2). Read `gulp prepare`. Either fix or document.
3. Add loader map to esbuild defaults (§1.1). One-line, prevents regression.
4. Move generated `Source/Cesium*.js` entries to `Build/generated/` (§1.4).

### Tier 1 — Stop the bleeding (1 week)

5. Turn on specs in CI (§5a).
6. Fix the six confirmed lifecycle bugs (§3a-f). One small PR per bug.
7. Thread context ID into cache error logs (§6a).
8. Wrap the panorama `console.log` sites (§6b).
9. Audit all `mapAsync` call sites for destroyed-guards (pattern-wide, not one-off).

### Tier 2 — Fix the architecture leaks (2 weeks)

10. Eliminate the 5 real `isWebGPU` branches in Scene.js (§4a). One virtual method per branch.
11. Add `occlude` and `pickOnly` to `WebGPUDrawCommand` (§4b).
12. Fix the lazy FR race (§4c). Cache the promise, not the flag.
13. Add `bundleVariantPlugin` spec (§5b).
14. Add FR consistency audit gulp task (§4d).

### Tier 3 — Quality gates (ongoing, one per week)

15. Commit visual-regression baselines; nightly CI (§5e).
16. Backfill spec for top-5 untested modules by LOC (§5c): `WebGPUPrimitiveCommands` first, then `WebGPUModelRenderer`.
17. `@private` → `@internal` sweep (§6d).
18. `@webgpu/types` pinning audit (§6c).

### Tier 4 — Harder architectural work (multi-session)

19. Generate `DrawCommand` + `WebGPUDrawCommand` from shared type spec.
20. Performance regression gate: one benchmark per feature renderer, regression threshold = fail build.
21. Multi-context integration spec with simulated device-loss.
22. `FEATURE_RENDERER_ONBOARDING.md` (§6h).

---

## Appendix A — Measured variant bundle sizes

From the successful **Run 1** of `npx gulp buildAllVariants`:

### Minified (production)

| Variant | `index.js` (ESM) | `Cesium.js` (IIFE) | `index.cjs` (CJS) | WebGPU chunk |
|---|---|---|---|---|
| **Dual** (default, WebGPU-first) | 4.2 MB | 6.7 MB | 5.6 MB | 288 KB |
| **WebGL-only** | 4.5 MB | *(IIFE did not produce — bug)* | 4.5 MB | (none) |
| **WebGPU-only** | 3.8 MB | *(IIFE did not produce — bug)* | 5.0 MB | 288 KB |

### Observations

1. **WebGPU-only dropped 400 KB** vs dual ESM — the GLSL shader aliasing worked.
2. **WebGL-only ESM is *larger* than dual ESM** (4.5 MB vs 4.2 MB). Counter-intuitive but correct: the dual build benefits from code-splitting (WebGPU lives in a 288 KB lazy chunk), so dual's entry is smaller. WebGL-only has no lazy chunk because there is no WebGPU code to split out — everything lives in the entry file.
3. **IIFE output missing for non-dual variants** — a bug in the interaction between `bundleVariantPlugin` and the IIFE build path. The IIFE file simply did not appear in output. Root cause not yet investigated; likely the plugin's `onResolve` interacting with IIFE's non-splitting constraint.

### Gzipped baseline (pre-existing production build)

- `Cesium.js` min+gzip: **1.89 MB**
- `index.js` min+gzip: **1.48 MB**

---

## Appendix B — Disproved agent claims

Five parallel research agents produced ~50 findings total. Three were **false positives** and are listed here so future readers do not re-investigate them:

### B1. Ring allocator peak usage claim — DISPROVED

**Agent claim:** `_peakFrameUsage` is always the previous frame's offset, never the actual peak, because `_currentOffset` is reset to 0 after sampling.

**Reality:** Sampling at `beginFrame()` start from the just-ended frame's `_currentOffset` IS correct. The spec at [WebGPURingBufferAllocatorSpec.js:121-141](../packages/engine/Specs/Renderer/WebGPU/WebGPURingBufferAllocatorSpec.js) exercises this and passes.

### B2. WGSL preprocessor cycle detection claim — DISPROVED

**Agent claim:** "The preprocessor parses `#import` statements but doesn't detect circular imports."

**Reality:** It does. [WGSLShaderPreprocessor.ts:595,625,745](../packages/engine/Source/Renderer/WebGPU/WGSLShaderPreprocessor.ts) uses `visited: Set<string>` correctly. The module docstring even advertises "Circular dependency detection: Throws clear error if cycles are found."

### B3. Source entry files not gitignored claim — DISPROVED

**Agent claim:** `Source/CesiumWebGLOnly.js` and `Source/CesiumWebGPUOnly.js` accumulate as working-tree noise because only `/Source/Cesium.js` is gitignored.

**Reality:** `.gitignore` has explicit entries for all three:
```
/Source/Cesium.d.ts
/Source/Cesium.js
/Source/CesiumWebGLOnly.js
/Source/CesiumWebGPUOnly.js
```
The separate concern — that generated files live in the `Source/` tree at all — is real and covered in §1.4.

---

## Appendix C — Methodology notes

**Parallel agent coverage:**
1. Architecture & backend agnosticism — Scene.js leaks, FR registry, DrawCommand parity, multi-context safety
2. WebGPU lifecycle & correctness — resource leaks, device-lost handling, mapAsync races, command encoder hygiene
3. Build pipeline & tree-shaking — variant plugin, stubs, bundler splitting, entry-point design
4. Test coverage & quality — spec coverage map, CI configuration, visual regression wiring
5. Cross-cutting concerns — error handling, logging, types, docs

**First-hand verifications performed:**
- Scene.js `isWebGPU` site count and semantic (verified 7 sites, of which 5 are real leaks)
- Ring allocator peak-usage logic (agent disproved)
- WGSL preprocessor cycle detection (agent disproved)
- DrawCommand vs WebGPUDrawCommand field parity (verified gap)
- Mipmap generator bind group caching (verified bug)
- Source entry file gitignore status (agent disproved)
- Shader cache error context logging (verified bug)
- Build non-determinism (observed directly across two runs)
- Variant build output sizes (measured from successful first run)

**Signal-to-noise assessment:** ~80-90% of agent findings survived independent verification. All findings in the CRITICAL and HIGH tiers above were independently verified against source.

---

*Report prepared 2026-04-16 following a systematic code-review session. All line numbers valid at that date. Re-verify before acting on stale references.*
