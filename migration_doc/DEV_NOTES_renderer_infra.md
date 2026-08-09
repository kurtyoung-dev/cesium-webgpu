# DEV notes — renderer infrastructure

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Scope: the C16-06 shard — pipeline / bind-group / shader-module caches, the
define registry and preprocessor, `WebGPUContext` and its extracted helpers,
the device pool, timestamp accounting, and the backend-agnostic renderer seams
(`GraphicsContext`, `ContextFactory`, `RendererType`, `FeatureRendererKey`,
`RenderCommand`).

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#forceSceneMRT`

_Moved 2026-08-08._

> ── C9-09-ATTACHMENT-DEMAND-REGISTRY (FAR-401-C0) ──
> Conservative force switch. While `true` the frame is forced to the
> historical full-MRT scene-FB topology regardless of consumer demand,
> preserving today's exact behavior. It stays `true` until C9-10 lands
> the demand-driven topology flip behind the Gate-B decision point
> (queue §3). Any un-enumerable consumer is covered by keeping this true
> (campaign 9 rule 3 — unknown demand keeps MRT).

Kept because it names the queue row that owns the flip and the campaign rule
that justifies the conservative default. The rewritten comment states that
demand-driven topology selection is not wired and that unknown demand keeps
MRT; it cannot say which row is expected to change that.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#_sceneColorResolveElisionEnabled`

_Moved 2026-08-08._

> C10-03-MSAA-BOUNDARY-BYTES — elision kill switch. Default `true` =
> demand-driven "resolve-on-consume" (the shipped behavior). Set `false` to
> restore the historical eager per-segment resolve (the scene-FB open sites
> bake `resolveTarget` again and `_ensureSceneColorResolved` becomes inert),
> so the two paths differ ONLY in resolve timing. Kept because the clean
> one-commit revert boundary cannot be exercised without git; this bool is
> the on/off/restored oracle mechanism (identical-build A/B) and a runtime
> safety fallback. Reverting the batch removes it together with the elision.

Kept because it records the verification role the flag was added for — an
identical-build A/B oracle, since the git-revert boundary is not exercisable
in a running viewer — and the intent that removing the elision removes the
flag with it. The rewritten comment states both behaviours and that the flag
is the only in-build way to A/B them.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#_logDepthWriteEnabled`

_Moved 2026-08-08._

> Renderer-wide log-depth master switch (Approach A for
> NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION / NEW-COLLECTIONS-LOG-DEPTH).
> Default TRUE since Batch 251: the globe (Batch 183), lit Phong
> primitives (Batch 188), depth plane (Batch 249), the five collections +
> compute-instance system (Batch 250), and the Model PBR pipeline family
> (Batch 251) all write csm_writeLogDepth-encoded `@builtin(frag_depth)`
> when `isWebGPULogDepthActive(context, frameState)` is true — matching
> WebGL's LOG_DEPTH path. Far-range depth ties (a billboard 1000 m above
> terrain at a 220 km camera was ~0.03 hyperbolic quanta — Batch 229
> measurement) now resolve at sub-meter precision. This remains a
> one-line kill switch: flipping it false restores hyperbolic NDC depth
> everywhere (every producer/consumer is define-gated and rebuilds
> through keyed cache misses / per-renderer flip guards). Remaining
> hyperbolic writers (Mat* primitives, Buffer* family,
> EllipsoidPrimitive, Vector3DTile, GroundPolyline's depth-sample read)
> are tracked under NEW-LOG-DEPTH-REMAINING-PRODUCERS in
> migration_doc/DEFERRED_WORK.md. See WebGPULogDepth.ts.

Kept for the per-producer adoption order and for the ledger row that owns the
remaining hyperbolic writers. The measurement (0.03 hyperbolic quanta for a
1000 m billboard at a 220 km camera) and the list of remaining writers survive
in the rewritten comment; the batch-by-batch adoption sequence does not.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#_pickLogDepthWriteEnabled`

_Moved 2026-08-08._

> NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — pick-fleet log-depth master
> switch, SEPARATE from `_logDepthWriteEnabled` (scene). The pick mini-frame
> owns its own single shared depth attachment (WebGPUSceneRendererPickPass,
> INV-2), so the whole native pick fleet must be uniformly hyperbolic OR
> uniformly log — a mixed FBO depth-tests incoherently. Historically this
> defaulted FALSE while the fleet was still uniformly hyperbolic. Batch 708
> (NEW-WEBGPU-VOXEL-PICK-LOG-DEPTH) cleared the last blocker (voxel had zero
> log-depth infra); C10-11 then converted EVERY remaining native pick producer
> (globe, model incl. hover/metadata/precise-pass, ellipsoid, splat, buffer
> point/polygon/polyline, billboard/point/polyline collections, primitive
> pick families) to write log `@builtin(frag_depth)` gated on
> `isWebGPUPickLogDepthActive`, so this flips TRUE in one coordinated change:
> the shared pick FBO is now uniformly log. OPAQUE picks write the log depth;
> BLEND/translucent picks keep depth-test-only (Batch-186 opaque-behind-
> translucent pickability). Flipping this false restores the uniformly-
> hyperbolic pick FBO (kill switch) — proven byte-identical (gate-off).

Kept for two facts the code cannot carry: that voxel pick was the last
blocker to the fleet-wide flip, and that the off state was proven
byte-identical at the time of the flip. The all-or-nothing constraint, the
producer list and the opaque/blend split survive in the rewritten comment.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#_warmUpPipelines`

_Moved 2026-08-08._

> Batch 71 — globe-surface warmup removed (was dead code).
>
> Previously this method did:
>   globeFR._instance = new globeFR.RendererClass(this);
>
> intending to pre-compile the terrain shader module + pipeline
> layout. But the actual render path in
> `GlobeSurfaceTileProviderRendering.addWebGPUDrawCommandsForTile`
> creates its OWN per-device renderer instance via a module-scoped
> `_webgpuGlobeRenderers` WeakMap and calls `.initialize(device,
> shaderCode, fmt)` on it. The `globeFR._instance` created here was
> never reached at render time, AND the constructor alone doesn't
> perform any GPU work (it just allocates a Float32Array scratch).
> So the warmup achieved nothing for globe.
>
> C10-06 Step C.1 — the fix is now wired. `warmUpGlobeRenderer` (a
> top-level export in `GlobeSurfaceTileProviderRendering.js`) populates the
> module-scoped `_webgpuGlobeRenderers` WeakMap and calls `.initialize`,
> which runs the 2-variant GlobeTerrain shader-module prewarm during this
> idle init window instead of on the first tile draw (measured ~176 ms
> `rendererReady→firstFrame` on WebGPU vs ~16 ms WebGL — the +146-200 ms
> stall the comment below wrongly called "below the perceptible
> threshold"). Fire-and-forget via a dynamic import so this never blocks
> `_initialize` from returning and never introduces an eager Renderer→Scene
> cycle (INV-06-2). Every failure mode is caught and dropped — the lazy
> first-frame path stays correct.

Kept because it records a refuted design (constructing the feature-renderer
instance, which the render path never reaches), the measurement that justified
replacing it, and the correction of an earlier comment that had called the
stall imperceptible. The mechanism and the 176 ms / 16 ms numbers survive in
the rewritten comment; the refuted attempt does not.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#_ensureDepthTexture`

_Moved 2026-08-08._

> Batch 86 (Phase 8a Slice 2b) — flipped on unconditionally
> (previously the comment said "guarded by opt-in" but no opt-in
> logic was ever implemented; the accessor `depthOnlyTextureView`
> always returned null, silently disabling HiZ and the G-buffer
> producer). Enabling unconditionally has negligible perf cost
> (one extra texture-usage bit, no per-frame work) and unblocks
> every compute-sampled-depth consumer.

Kept because it records a comment that described a gate the code never had —
the kind of defect a reader can only catch by comparing prose against
behaviour. The rewritten comment states the unconditional usage bit and the
failure it prevents.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `WebGPUContext#getRendererStatistics`

_Moved 2026-08-08._

> near-zero bind-group hitRate is the Batch-717 churn shape (resource
> identities recreated every frame without cache invalidation).

Kept because it names the batch whose investigation established what a
near-zero bind-group hit rate means. The diagnostic reading survives in the
rewritten comment.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts` — `WebGPURenderPipelineCache#generateCacheKey`

_Moved 2026-08-08._

> Until 2026-08-06 this hashed `descriptor.name` plus structural fields ONLY.
> It read neither `vertex.module` / `fragment.module` / `entryPoint` nor any
> define bitmask, so a shader define that changed neither the descriptor
> NAME nor the vertex layout aliased silently: the producer rebuilt its
> descriptor around a correctly-recompiled module, looked it up under an
> unchanged name, and was handed the pipeline compiled from the OLD module.
> That cost two rounds of point mitigations (Batch 795's `wrongModuleHits`
> counter, Batch 803's eight `, ld=1` name markers) and voided the OFF leg
> of five probes for months.

Kept because the cost record — two rounds of point mitigation and five probes
whose OFF leg was void for months — is the argument for closing this class
structurally rather than with another marker, and CLAUDE.md quotes it. The
aliasing mechanism and the strength of the module-identity fold survive in the
rewritten comment; the cost record does not.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — `ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION`

_Moved 2026-08-08._

> ★ WHY THIS IS A COMPILE-TIME VARIANT AND NOT A UNIFORM. `C13-39`'s
>   negative result established that WGSL register allocation is STATIC:
>   anything added to the shared `ProceduralClouds` module inflates EVERY
>   pipeline compiled from it — the visible march, the full-resolution
>   march, the shadow map, the cascade atlas and the god-ray mask, four of
>   which want nothing to do with a reconstruction attachment. Gating the
>   emission on a uniform would pay the registers on all of them
>   unconditionally. Gating it on this bit means the four non-emitting
>   pipelines compile the module at `definesHi = 0`, where the preprocessor
>   has already deleted the emission text, so their register footprint is
>   exactly what C13-39 measured. Any occupancy claim about the EMITTING
>   pipeline is owed the interleaved-A/B protocol.

Kept for the two claims that are about the work rather than the code: that the
static-register-allocation result came from a specific closed-negative
measurement, and that any occupancy claim about the emitting pipeline owes the
interleaved-A/B protocol. The mechanism survives in the rewritten comment.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — `ShaderDefineHi.CLOUD_RECONSTRUCTION_CONSUME`

_Moved 2026-08-08._

> ★ THE POLICY BOUNDARY IS THE LEDGER'S. `C13-12` "owns attachment-aware
>   motion/depth rejection, variance clipping, reactive history, wind
>   advection in reprojection, disocclusion". So every THRESHOLDED test
>   belongs to that row; this bit gates only the READS and the non-parametric
>   validity plumbing (the producer's own validity flag, and the exactly-
>   equivalent empty-neighbourhood early-out the coverage moment licenses).

Kept because the boundary is a queue-ownership fact: it says which row a
future thresholded test belongs to, which the code cannot say. The scope of
what this bit does and does not gate survives in the rewritten comment.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — `ShaderDefine.MODEL_HAS_FEATURE_ID_0`

_Moved 2026-08-08._

> Why variant-conditional (Session 65, Batch follow-up to NEW-VR-VERTEX-BUFFER-VARIANT):
> the full Model PBR layout had 9 vertex slots (position, normal,
> tangent, texCoord0, color, joints, weights, texCoord1, featureId0).
> Session 62's `MODEL_HAS_TEXCOORD_1` made slot 7 conditional,
> dropping the common case to 8. But primitives that ALSO carry a
> feature ID (every batched 3D Tiles tileset — BIM, AEC, Photogrammetry,
> Clipping Planes etc.) still hit 9 and refuse to compile on Edge's
> 8-slot adapter limit. Dropping slot 8 for primitives without a
> feature ID brings the most-common case (standard glTF models with
> no batch table) to 7 slots; primitives with feature IDs but no
> texCoord1 land at 8; primitives with both stay at 9 (a small
> sub-cluster — multi-UV models that are also batched — still needs
> the deeper restructure noted in DEFERRED_WORK).

Kept because the residual case — a multi-UV model that is also batched, which
still cannot compile on an 8-slot adapter — is tracked in the deferred-work
ledger, and this is the only place the two are linked. The slot arithmetic and
the residual case survive in the rewritten comment.

---

### `packages/engine/Source/Renderer/WebGPU/WebGPUDevicePool.ts` — `WebGPUDevicePool#_createNewDevice`

_Moved 2026-08-08._

> Batch 152 — maxBindGroups opt-up reverted. The probe environment
> (Chromium on Windows, both D3D12 + Vulkan backends) caps
> maxBindGroups at the spec default of 4. Forward+ clustered
> lighting's planned @group(4) addition can't land as a separate
> bind group on this platform; the eventual integration must
> merge clustered lighting bindings into one of the existing
> 4 groups (camera/material/instance/effects) instead. Falls

Kept because it records a measurement of a specific platform — Chromium on
Windows, both D3D12 and Vulkan backends — and a design consequence that
outlives the code: clustered lighting cannot claim a fifth bind group there.
Both survive in the rewritten comment; the measurement's provenance does not.

---

### `packages/engine/Source/Renderer/FeatureRendererKey.js` — `FeatureRendererKey.GROUND_ATMOSPHERE`

_Moved 2026-08-08._

> RETIRED (Batch 239) — superseded by in-GlobeTerrain.wgsl ground
> atmosphere (csm_computeGroundAtmosphereScattering + WebGPUAtmosphereLUT,
> params in the globe camera/tile uniform buffers), matching WebGL's
> in-GlobeFS integration. The separate-pass WebGPUGroundAtmosphereRenderer
> was deleted (full Nishita reference in git history at 05b6da60d1).
> Keys are positional — keep slot 29 reserved; do NOT reuse the number.

Kept for the git commit that still holds the deleted separate-pass Nishita
implementation, `05b6da60d1` — the only pointer to a full reference version of
that renderer. The retirement, the replacement and the reserved-slot rule
survive in the rewritten comment.
