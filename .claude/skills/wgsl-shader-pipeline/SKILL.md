---
name: wgsl-shader-pipeline
description: WGSL shader rules — the ShaderDefine and ShaderSourceId registries, //>>ifdef preprocessor, module cache, adding a define bit, pipeline-key aliasing. Read before shader-variant work.
---

# WGSL Shader Pipeline — Defines, Preprocessor, Module Cache

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

Infrastructure landed in Batches 22-27. Do not bypass these when adding shader variants.

## `ShaderDefine`, `ShaderDefineHi` & `ShaderDefineExt` bitmask registries (`WebGPUShaderDefines.ts`)

- **Three-word define space:** `ShaderDefine` (lo) and `ShaderDefineHi` (hi) each have bits 0-30 fully assigned. New specialization axes claim `ShaderDefineExt` bits within the owning subsystem's allocation in `Tools/visual-regression/fixtures/shader-registry-layout.json`. Bit 31 is reserved in every word; the lo-word reservation supports collections' `noDepthTest` pipeline-key fold (`pipelineKeyWithDepthFlag`). The Ext word is independent and travels as `definesExt` through preprocessing and module caching.
- **Cloud Ext bound:** Cloud allocations may use only Ext bit indices 0-20 (`definesExt < 2^21`, the layout ledger's `cloudExtMaxBit`). The planned W10b renderer source-cache keys use `flags + definesExt * 2^32` (plan N6, as the `ShaderDefineExt` doc comment states), so this bound preserves exact JavaScript integer packing. The shader-module cache itself keeps Ext in a separate map level.
- Branded types `ShaderDefineLoMask`, `ShaderDefineHiMask` and `ShaderDefineExtMask` distinguish registry values at compile time; the numeric hi/Ext arguments still require call-site review.
- **Add-only. Never reorder, renumber, or remove** an entry even if its last consumer disappears. Reordering silently aliases cached modules; removal breaks any pipeline still referencing the bit. Deprecated entries stay with a comment marker.
- `ShaderSourceId` registry follows the same rules. Source ID 0 is reserved.

## `//>>ifdef` preprocessor (`WebGPUShaderPreprocessor.ts`)

- Directives: `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif` on their own lines. Flag names must match the UPPERCASE_WITH_UNDERSCORES pattern and resolve to a `ShaderDefine`, `ShaderDefineHi` or `ShaderDefineExt` bit.
- Unknown flag names throw at preprocess time with the source line number — typos fail loudly, not silently.
- The preprocessor is a pure function over `(source: string, defines: ShaderDefineLoMask, definesHi: number = 0, definesExt: number = 0) → string`. Same input always produces same output; callers cache results in `WebGPUShaderModuleCache`.
- `defines=0, definesHi=0, definesExt=0` selects the `//>>else` branch of each conditional block. Sources with no directives retain their exact bytes.

## Shader module cache (`WebGPUShaderModuleCache.ts`)

- Tier 1 — per-`GPUDevice` dedupe keyed by the exact safe integer `((defines >>> 0) * 0x100) + sourceId`. This retains the complete 32-bit lo define mask while reserving eight low bits for the validated source ID; JavaScript represents every resulting 40-bit key exactly. One cache per device; cleared on device loss.
- Hi and Ext widening use separate numeric map levels. With `definesExt === 0`, the historical lo-only and `(definesHi → loKey)` paths remain unchanged. A nonzero `definesExt` selects a lazily created `(definesExt → definesHi → loKey)` map.
- `getOrCreate(sourceId, source, defines, label, keySalt?, definesHi?, definesExt?)` is the entry point. Call `prewarm(sourceId, source, defineSets, labelPrefix)` at renderer init for known-hot variants; each define set may be a lo mask, `[defines, definesHi]`, or `[defines, definesHi, definesExt]`.
- A non-zero `keySalt` is only for generated WGSL whose source text adds an identity dimension beyond `(sourceId, defines, definesHi, definesExt)` (e.g., dynamic metadata chunks); it is not an overflow escape hatch.
- Labels should include the define bitmask hex for devtools readability (`prewarm` does this automatically).

## Adding a new define bit

1. Lo and hi bits 0-30 are full. For a new specialization axis, claim a vacant `ShaderDefineExt` bit in the owning subsystem's range in `Tools/visual-regression/fixtures/shader-registry-layout.json` and append its declaration using `extDefineBit(n)`. Never claim bit 31, move an existing allocation or rename an assigned bit. Cloud Ext allocations stay at bit 20 or below. For an already declared reserved axis, keep its name, word, bit and owner unchanged; when its consumer lands, flip `status` from `reserved` to `consumed` in the ledger only, keeping its consumer records accurate. The flip lands in the same change as a qualified consumer: `Tools/visual-regression/webgpu-shader-registry-layout.spec.mjs` derives every entry's expected status from engine sources that read the bit by name (an imported `ShaderDefine` / `ShaderDefineHi` / `ShaderDefineExt` / `ShaderSourceId` property, a `resolveDefineBit*("NAME")` call or a `//>>ifdef NAME` directive), and an engine literal (`1 << n`, a bare source id) is never a consumer.
2. Document what the axis gates and which shaders consume it in its JSDoc block.
3. For each consuming shader, add `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif`; keep the `//>>else` branch as the historical code path.
4. Route shader-module creation through `preprocess(code, defines, definesHi, definesExt)` or `moduleCache.getOrCreate(sourceId, source, defines, label, 0, definesHi, definesExt)` so the directives resolve.
5. _(Optional — defense in depth, no longer required for correctness.)_ Add a marker for the axis to the pipeline descriptor's `name`, or stamp the mask. See the next section for why this was demoted.

## Pipeline-key aliasing is handled STRUCTURALLY — per-axis markers are defense-in-depth

`WebGPURenderPipelineCache.generateCacheKey` folds **shader-module identity** into every key (`sh:<vsId>.<vsEntry>/<fsId>.<fsEntry>`, via a `WeakMap`-backed `webgpuObjectIdentity`), alongside `pl:` layout identity, `pr:` primitive state, `dz:` depth/stencil state and `mx:` multisample extras — i.e. every field `buildPipelineDescriptor` forwards to `createRenderPipeline`. `WebGPUComputePipelineCache` folds `compute.module` the same way (`m:`).

Because `WebGPUShaderModuleCache` hands out a distinct `GPUShaderModule` per `(sourceId, defines, definesHi, definesExt, keySalt)`, **a new define bit cannot alias in the pipeline cache regardless of whether anyone remembers step 5.** Module identity is strictly stronger than the mask: it also separates producers that compiled different source text under the same mask, and producers that call `device.createShaderModule` directly.

This was `NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL` (fold landed Batch 825, Edge-verified in both probe modes at Batch 828 — 3,729 pipeline calls, 0 collisions, `wrongModuleHits` 0, and the negative control fires). Before it, the key read neither the module nor the mask — and since **no caller passes a `variant`**, not `primitive.cullMode` or most of `depthStencil` either. The whole marker fleet (`, ld=1`, `, noCull`, `, imagery4`, `, enhOcean`, `defines=0x…`, `[sf=…]`) existed to stand in for those omissions, at the cost of two batches of point mitigation and five probes whose OFF legs were void for months.

- **Keep every existing marker.** A bare `sh:41.…` says two rows are distinct but not WHICH variant each one is; markers are what make `describeCacheKey()`, `listPipelineVariants()` and devtools labels readable. Remove one only with proof.
- **`stats.wrongModuleHits` must stay and must read 0.** A served hit now implies identical modules by construction, so the counter is the runtime canary that the fold is still reached — not dead code (Principle 7).
- **Producers may declare `descriptor.defines` / `definesHi`** (the globe does). Optional; omitting it leaves the key byte-identical to what it would otherwise be.
- Guard: `Tools/visual-regression/pipeline-key-aliasing.spec.mjs` — its STRUCTURAL group executes the real caches over every bit of the real `ShaderDefine` registry with markerless descriptor names; its MUTATION-FOLD group removes the fold from a copy of the engine source and requires the aliasing to come back.
