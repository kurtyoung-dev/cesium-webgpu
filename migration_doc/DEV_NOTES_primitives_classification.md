# DEV notes — primitives and classification

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

### `packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts` — `(module docblock)`

_Moved 2026-08-21._

> **Migration Session 5 (Batch 85, ADR-2026-04-28) — current role:**
> the depth-sample classifier
> (`WebGPUGroundPrimitiveRenderer`) is the runtime consumer of this
> module. The depth-pack pipeline is still active and produces
> `_packedTranslucentDepthView` per frame; the depth-sample classifier
> (Migration Session 2) reads it as the source of front-most
> translucent surface depth. The depth-sample classifier draws
> directly into scene color, so the prior accumulation-FBO + composite
> scaffolding is no longer wired:
>
>   - `_runTranslucentTileClassificationComposite` was removed from
>     `WebGPUSceneRenderer`; nothing now calls `composite()`.
>   - `_classificationColorTexture` / `_classificationColorView` are
>     allocated but never written. They are inert until a future
>     cleanup batch removes them.
>   - The composite pipeline (`_compositePipeline`, `_compositeBGL`,
>     `_compositeBindGroup`, `_compositeShaderModule`,
>     `COMPOSITE_WGSL`, `_ensureCompositePipeline`) is similarly
>     allocated but unreferenced.
>
> Removing the unused scaffolding cleanly is a follow-up batch (~100
> LOC of careful surgery in this file). It was deferred from Session 5
> to keep the migration's runtime correctness changes isolated from
> code-removal churn.

Kept because deleting either half would remove infrastructure that is meant to
be completed together.

### `packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts` — `COMPARE_AND_PACK_MSAA_WGSL`

_Moved 2026-08-21._

> C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA variant of the
> compare-and-pack pipeline. WGSL `textureSample` cannot read a
> `texture_depth_multisampled_2d`, and MSAA depth attachments cannot be
> MSAA-resolved via a render-pass `resolveTarget` (only color targets
> support that). The workaround mirrors the Batch 43 globe-depth path:
> bind both depth sources as `texture_depth_multisampled_2d` and read
> `sampleIndex = 0` via `textureLoad`.
>
> Sample 0 is the canonical "first hit" used elsewhere in the project
> (see `DEPTH_COPY_MSAA_WGSL` in `WebGPUGlobeDepth.ts`). For translucent
> classification specifically, sample 0 produces output equivalent to
> the single-sample copy path: the WebGL `CompareAndPackTranslucentDepth`
> reference also operates on the resolved single-sample depth, and our
> `_translucentDepthTexture` (single-sample, populated via
> `copyTextureToTexture`) is itself the result of an implicit
> resolve-by-copy on the single-sample side. Per-sample averaging would
> introduce a packed-format rounding question and dominate the cost
> without changing classification correctness — `if (translucent >
> opaque) translucent = 1.0` is binary, so a single representative
> sample is sufficient. No sampler binding is needed (textureLoad is
> unsampled).
>
> In MSAA mode the FIRST-CUT scope is preserved: both opaque and
> translucent depth come from the same scene framebuffer depth texture
> (the over-broad capture the single-sample path also uses). With
> translucentDepth == opaqueDepth, the `>` test is always false, so
> the packed output is the scene depth — same end result as the
> single-sample copy + pack would produce.

Kept because the choice of sample zero and the currently identical inputs are
not obvious from the binding types alone.

### `packages/engine/Source/Renderer/WebGPU/WebGPUClippingPolygonCollection.ts` — `(module docblock)`

_Moved 2026-08-21._

> Packing convention (GLOBE-CLIPPOLY-GEODETIC fix): the CPU pack is the SAME
> `packPolygonsAsFloats` the WebGL path uses (invoked through
> `ClippingPolygonCollection.packDataForFeatureRenderer`), so polygon vertices
> and extents are in spherical `fastApproximateAtan2` coordinates and the
> positions texture carries the upstream per-polygon layout the compute
> shader expects: 1 header pixel `(positionsLength, extentsIndex)` + 2
> individual-extent pixels + one pixel per vertex. The previous
> implementation packed raw geodetic `(lon, lat)` pairs with no headers,
> which the SDF compute shader (a port of `PolygonSignedDistanceFS.glsl`)
> could not consume — the whole WebGPU clipping-polygon path produced
> garbage SDF data and never activated.

Kept because the texture is structurally valid under either representation,
making a schema mismatch difficult to diagnose from validation output.

### `packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts` — `extractEdgeGeometry`

_Moved 2026-08-21._

> C-R8-EDGE-LINESTRINGS (NEW-EDGE-DISPLAY-MODE-WEBGPU, edge-data slice)
> — `extractEdgeGeometry` now also consumes the explicit
> `edgeVisibility.lineStrings` array (BENTLEY / styled-gltf-lines
> assets). Previously the extractor early-returned when
> `edgeVisibility.visibility` was absent, so lineStrings-only primitives
> emitted ZERO WebGPU edges. Each lineString's primitive-restart-
> delimited index list now produces one HARD edge per consecutive index
> pair, deduped against the same edge set the visibility path uses
> (matches WebGL `EdgeVisibilityPipelineStage.extractVisibleEdges`).

Kept because a seemingly harmless early return can silently disable a valid
asset shape.

### `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts` — `resolvePrimitiveImports`

_Moved 2026-08-21._

> NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT (Batch 180) — the Buffer* material
> WGSL uses bare `#import Name;` directives. The runtime preprocessor that
> was supposed to resolve them (`context.shaderCache.preprocessOnly`) is
> never wired — `context.shaderCache` is the WebGL `ShaderCache` (no
> `preprocessOnly`), the `WebGPUShaderCache` is never instantiated, AND its
> `WGSLShaderPreprocessor` only matches the quoted `// #import "path"` form,
> not the bare `#import Name;` form — so the directives reached the WGSL
> compiler verbatim and `#` failed as an invalid token. Resolve them
> deterministically by inlining the chunk source from this map, matching the
> JS-string-interpolation pattern every other WebGPU renderer uses (e.g.
> GroundPrimitive's `${csm_depthClamp}`). All five chunks are leaf (no
> nested `#import`), so a single in-place pass suffices.

Kept because routing bare names through either neighboring mechanism leaves
valid primitive shader imports unresolved.

### `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts` — `LOG_DEPTH_VERTEX_CHUNK`

_Moved 2026-08-21._

> NEW-BUFFER-LOG-DEPTH (Batch 263) — the Buffer* material shaders now join the
> renderer-wide logarithmic-depth epic. They use the SAME canonical chunk
> library as the five collection shaders + Model PBR:
>   vertex:   v_logDepth = csm_vertexLogDepth(clipPos, near);
>             out.position = csm_updatePositionDepth(clipPos);
>   fragment: out.depth = csm_writeLogDepth(v_logDepth, factor);  // @builtin(frag_depth)
> The `near` / `factor` (= oneOverLog2FarDepthFromNearPlusOne) scalars ride in
> the reserved `.w` pad lanes of the shared `CameraUniforms` struct
> (encodedCameraPositionMCHigh.w / cameraPosition.w — see WebGPULogDepth.ts +
> chunks/structs/CameraUniforms.wgsl), packed by `packCameraLogDepthLanes`.
>
> Previously these import names resolved to a 1-arg `csm_vertexLogDepth` + an
> empty `csm_writeLogDepth` no-op, so the Buffer family ALWAYS wrote hyperbolic
> NDC depth and never consulted `isWebGPULogDepthActive`. That stub comment was
> actively wrong as of Batch 251: the WebGPU globe writes LOG depth now, so the
> Buffer fill geometry sank behind terrain at far cameras whenever the master
> switch was on. The `//>>else` branch of each shader keeps the historical
> hyperbolic path so LOG_DEPTH-off is byte-identical. `csm_updatePositionDepth`
> ships inside the `csm_vertexLogDepth` chunk; both chunks are leaf (no nested
> `#import`).

Kept because shader compilation alone does not prove that the imported helper
participates in depth encoding.

### `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts` — `computeBufferPrimitiveBoundingSphere`

_Moved 2026-08-21._

> NEW-BUFFERPOLYLINE-2D-EXTRUSION — scene-mode-aware command bounding volume.
>
> PARITY-BUFFER-2DCV reprojects the packed vertex positions into the 2D/CV
> render frame, but the draw command kept carrying the raw world-space (ECEF)
> bounding sphere. In SCENE2D the orthographic culling volume lives in the
> projected frame, so the ECEF sphere usually falls outside it and the whole
> command is frustum-culled — the polyline/polygon "absence" in 2D was a
> culling bug, not an extrusion bug (the screen-space quad extrusion already
> produces correct clip positions there; verified via cull=false probe).
>
> Mirrors upstream `PrimitiveCommandHelpers.updateAndQueueCommands`:
>   SCENE3D  — the collection's world-space sphere (same reference as before;
>              byte-identical default path).
>   2D / CV  — `BoundingSphere.projectTo2D(...)` (center in the (z,x,y)
>              swizzled render frame, matching the repacked positions).
>   MORPHING — union of the world-space and projected spheres, so the command
>              survives culling throughout the morph blend.
>
> Storage lives on the cache (`_modeBV` / `_modeBVMorph`) because the command
> holds the returned reference across the frame.
> @private

Kept because the visible failure resembles a shader or geometry defect even
though the cause is the coordinate system of the bounds.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js` — `resolveInjectedChunkMarkers`

_Moved 2026-08-21._

> Batch 139 — was a strict `"// @chunk csm_samplePointShadow"` substring
> match. That bricked 9 shaders that had the marker on the same line as
> other comment text (e.g., `// Batch 167 - B.12 chunk usage. @chunk
> csm_samplePointShadow`) — the leading `// Batch 167...` prefix meant
> the literal "// @chunk csm_samplePointShadow" substring never appeared
> in source, so the chunk wasn't injected and every draw of those shaders
> produced "unresolved call target" WGSL parse errors. Switched to a
> regex that matches `@chunk csm_samplePointShadow` regardless of
> leading comment text. Still requires the marker to be in a comment
> (line starts with `//` after optional whitespace) so accidental matches
> in WGSL code or string literals can't trigger injection.

Kept because strict matching appears safer but rejects source emitted by the
shader generator.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `ensureUncompressedAttributes`

_Moved 2026-08-21._

> =========================================================================
> DP-H19 — CPU decompression of `compressedAttributes`
> =========================================================================
>
> `GeometryPipeline.compressVertices()` (invoked when the Primitive has
> `compressVertices: true`, which is the DEFAULT) deletes the
> `normal` / `st` / `tangent` / `bitangent` attributes and replaces them
> with a single `compressedAttributes` Float32Array containing oct-packed
> normals and bit-packed UVs. The WebGPU primitive rendering path reads
> `geometry.attributes.normal` and `geometry.attributes.st` directly —
> which are deleted — so every default-configured Primitive rendered
> flat-shaded with black textures.
>
> The WebGL path handles this via `#ifdef COMPRESSED_VERTICES` in the
> vertex shader, decoding `compressedAttributes` on the GPU. We could
> mirror that in WGSL, but the shader-variant explosion across
> material-type × compressed-input × pick is substantial. For a simpler
> correctness fix we decode on the CPU here, reconstructing the original
> `normal` / `st` attributes as Float32Arrays. This loses the VRAM /
> bandwidth savings that compression is meant to provide, but makes
> every `compressVertices: true` primitive render correctly on WebGPU.
> Shader-side decode is tracked as **FOLLOW-UP DP-H19-SHADER-DECODE**.
>
> `compressVertices()` layout per-vertex (see `GeometryPipeline.js:1558-1615`):
>
>     components = (hasSt && hasNormal ? 2 : 1) + (hasTangent||hasBitangent ? 1 : 0)
>     slot[0]: if hasSt           → packedST (via `compressTextureCoordinates`)
>     slot[1]: if hasNormal AND hasTangent AND hasBitangent
>              → octPack(normal, tangent, bitangent) occupies 2 slots
>              else → one octEncodeFloat per (normal, tangent, bitangent)
>                    independently, in that order
>
> We consult `geometry._compressedAttributesMeta` (written by
> `GeometryPipeline.compressVertices` right before it starts encoding)
> to know which attributes were present so the decode is unambiguous.
> If the meta isn't attached (geometry came from a non-upstream code
> path), we fall back to inferring from `componentsPerAttribute` and
> log a one-time warning.
>
> Scratch Cartesians are reused across decode calls to avoid per-vertex
> allocations.

Kept because the CPU fallback, inference ambiguity, and retained GPU boundary
must be considered together before removing either representation.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `mapCesiumPrimitiveTypeToWebGPU`

_Moved 2026-08-21._

> Map a Cesium `PrimitiveType` (GL enum) to a WebGPU primitive topology
> string. Returns null for `TRIANGLE_FAN` (WebGPU doesn't support it —
> caller falls back to `triangle-list`, which is wrong but harmless for
> the rare TRIANGLE_FAN consumer; mainstream Cesium geometry uses
> triangle-list or line-list).
>
> Session 65 Batch 2 (2026-05-11): without this mapping the primitive
> pipeline factory hardcoded `triangle-list`, so outline geometries
> (`BoxOutlineGeometry`, `CylinderOutlineGeometry`, every
> `*OutlineGeometry.primitiveType = PrimitiveType.LINES`) rendered as
> triangles. The vertex buffer carried line endpoints, the index buffer
> carried line indices, the rasterizer interpreted them as triangle
> strips of garbage — visible as missing outlines on every CZML box
> with `outline: true`, every CZML cylinder, etc. (~12 CZML demos).
> @private

Kept because the fallback is a known semantic limitation, while line topology
is a correctness requirement.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `writeLogDepthTail`

_Moved 2026-08-21._

> Writes the renderer-wide log-depth tail (vec4: near, far, factor, reserved)
> starting at float index `offset`. Mirrors WebGPUGlobeSurfaceCameraUB's tail.
> Safe to call unconditionally — it only fills previously-unread floats, so it
> is inert until the LOG_DEPTH pipeline define is set (Slice 4 flip) and the
> shader's `logDepth` field reads it. See WebGPULogDepth.ts.
>
> NEW-WEBGPU-MAT-LOGDEPTH-MULTI-PRIMITIVE-DEPTH-LOSS — the encode frustum
> MUST be the frame-stable FULL-camera stash `_logDepthEncodeNearFar`
> (published by the globe camera-UB pack and by both frustum loops BEFORE any
> per-slice remap), NOT the live `currentFrustum`/factor pair. The live pair
> is a moving target — `_updateFrustumUniforms` re-slices it per frustum
> slice, the translucent near refresh re-slices it again, and the pick loops
> re-slice it for the pick mini-frame — so a tail packed from it encodes
> whatever slice state happens to be current at THIS primitive's pack moment.
> That made the Mat/PBR/Basic/polyline geometry-Primitive family the LAST
> log-depth producer whose curve depended on pack timing. A first online-
> terrain probe attributed a 0.868 slab/globe ratio to this mismatch, but the
> corrected deterministic ellipsoid-terrain probe measures 0.996; that old
> number was an instrument false positive, not causal proof. The contract
> mismatch itself was real and is closed here. Every sibling producer is
> already stash-first — see the identical pattern + rationale in
> WebGPUBillboardRenderer.packUniforms, WebGPUPointPrimitiveRenderer, and
> WebGPUDepthPlane.update (NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT). When
> the stash drives, its frame-stable factor was derived alongside the same
> pair so encode + factor stay self-consistent without per-command logarithm
> work; `currentFrustum` remains only as the
> pre-stash early-frame fallback. The pick fleet is unaffected today (its
> tail lanes are read only under the separate pick-fleet switch, C10-11) and
> inherits the same full-camera encode both pick loops publish when it flips.
> @private

Kept because it records both the timing mechanism and why the stronger-looking
measurement must not be reused as proof.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `writeRTEUniformsPolyline`

_Moved 2026-08-21._

> NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU (COLOR slice) — writes the camera
> UB for the polyline appearance shader. The polyline VS does its width
> expansion in screen space, so it needs the full projection /
> viewportTransformation / viewportOrthographic / modelViewRTE chain plus
> pixelRatio + frustum-near, on top of the flat-parity head.
>
> Layout (float offsets — byte-locked to CameraUniforms in
> PolylineColorAppearance.wgsl):
>   0-15  mvpRelativeToEye        (parity)
>   16-19 encodedCameraHigh + pad (parity)
>   20-23 encodedCameraLow  + pad (parity)
>   24-39 projection
>   40-55 viewportTransformation
>   56-71 viewportOrthographic
>   72-87 modelViewRelativeToEye
>   88    pixelRatio
>   89    currentFrustumNear
>   90-91 pad
>
> The viewport projection receives the context-owned clip-space convention
> explicitly; no process-global Matrix4 mode is consulted.
>
> MISSING-FUNCTIONALITY NOTE (Principle 9): `uniformState.viewport` is only
> ever set by the WebGL `RenderState.applyViewport` path (it calls
> `gl.viewport`). The WebGPU render path never seeds it, so
> `uniformState.viewportOrthographic` / `.viewportTransformation` stay at
> IDENTITY on WebGPU — which collapsed every polyline-appearance vertex to
> one clip point (the original 0px symptom, take two). We therefore build
> both screen-space matrices from `context.drawingBufferWidth/Height` here,
> matching the established WebGPU collection-renderer pattern (Billboard /
> BufferPolyline read `context.drawingBufferWidth` directly rather than the
> GL-only `uniformState.viewport`). Seeding `uniformState.viewport` in the
> WebGPU render pass setup is the broader fix that would let the getters
> work for all future screen-space WebGPU shaders — tracked as follow-up.
> @private

Kept because the local shipped fix and the broader unfinished ownership must
not be mistaken for duplicate implementations.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `createWebGPUCommands`

_Moved 2026-08-21._

> Session 65 Batch 3 (2026-05-11): use BACK-face culling when the
> appearance is closed (Box, Sphere, Ellipsoid, Cylinder — every
> closed convex volume). Mirrors WebGL's
> `Appearance.getDefaultRenderState(...)` which sets
> `cull: { enabled: true, face: BACK }` when `closed: true`.
>
> The previous hardcoded `cullMode: "none"` left BOTH front and
> back face triangles in the rasterizer. With `depthWriteEnabled =
> true` (opaque path) the two faces fight depth-test at triangle
> edges where their Z values nearly match — back-face fragments
> win some pixels, creating visible "see-through" gridlines along
> every triangulation seam. The user-reported symptom: single
> opaque red sphere shows lat/long grid + imagery bleeding through
> (Show or Hide Entities, single ellipsoid test, every closed-
> shape entity demo).
>
> For non-closed appearances (Polyline, polygon outline, etc.)
> we still pass `none` so both faces continue to render — those
> primitives don't have a meaningful "back" face.
>
> EquirectangularPanorama cull-override (#13369): a closed appearance
> can still explicitly DISABLE culling via
> `renderState.cull.enabled: false`. WebGL honors this — its
> `Appearance.getDefaultRenderState(...)` runs the `closed` branch
> through `combine(existing, rs, true)` where the user's
> `cull.enabled: false` wins over the closed-default `enabled: true`.
> A panorama is `closed: true` (sphere) viewed from the inside, so it
> sets `cull.enabled: false` to keep the inner faces visible. Without
> this check WebGPU would back-face cull the interior and render the
> panorama blank. When cull is explicitly disabled we force `none`
> regardless of `closed`; the closed-volume two-pass cull behavior
> (DP-H17) below only applies on the `cull.enabled !== false` path.

Kept because both defaults are correct for different viewing arrangements and
neither can safely override the other unconditionally.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `createMaterialPipelineAndCache`

_Moved 2026-08-21._

> Slice 5d Batch 156 — match the scene FB MSAA sample count, same
> fix the material pipeline site got in Batch 132. Without it this
> first-site pipeline (phong / phongTextured / basic / basicTextured
> — i.e. PerInstanceColorAppearance + basic ColorAppearance) defaults
> to sampleCount=1 against the MSAA=4 scene FB pass, so WebGPU
> rejects it with "Attachment state not compatible with Scene
> Framebuffer Render Pass" and the primitive renders black. The
> Batch 132 fix only covered createMaterialPipelineAndCache (Mat*);
> this site (selectWebGPUShader-based shaders) was missed.

Kept because the duplicated pipeline-construction sites make a partial fix look
complete.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `createWebGPUCommands` per-vertex color packing

_Moved 2026-08-21._

> ── Per-VERTEX color via batchId (C4-PLAIN-HDR-GAMMA-TAILS c) ──
> When Cesium combines multiple PerInstanceColorAppearance instances it
> produces ONE geometry whose color lives in the batch TABLE, selected
> per-vertex by a `batchId` attribute (0 for instance 0's vertices, 1 for
> instance 1's, …) — exactly what WebGL's PerInstanceColorAppearanceVS
> resolves by sampling the batch-table texture. The single `instanceColor`
> above is instance `i`'s batch color, but a combined geometry has fewer
> geometries (often 1) than instances, so applying instance 0's color to
> every vertex painted BOTH boxes with one color (orange box drawn
> cornflower blue). Bake the per-vertex color CPU-side by looking up each
> vertex's `batchId` in the batch table. Fall back to a per-vertex `color`
> attribute (geometries built with explicit colors), then `instanceColor`.
> Single-instance byte-identical: batchId≡0 → instanceColors[0] equals the
> old getBatchedAttribute(0) value.

Kept because the wrong implementation renders valid colors and can pass tests
that use only one instance.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `ensureMaterialTextureBindGroup`

_Moved 2026-08-21._

> Water needs both the wave-normal perturbation texture and the
> "where water is" specular mask. Pre-Batch-25 WebGPU only bound
> `specularMap` at @binding(1) but the shader read it as if it
> were the normal map — a subtle mislabel that produced chaotic
> wave behavior on ocean tiles.
>
> Slice 5c-B Batch 124 — bug fix surfaced by the litmat polygon probe
> (probe-litmat-mrt). Pre-fix: `isLit ? VERTEX_FRAGMENT : VERTEX`.
> The Flat material shaders (e.g. PrimitiveMatColorFlat) read
> `camera.encodedCameraHigh` + `camera.encodedCameraLow` in fragment
> for the FEAT-GAP-09 aerial-perspective fog block at L99. With the
> pre-fix gate, Flat pipelines built camera BGL with VERTEX-only
> visibility and the shader's fragment read tripped "Entry point's
> stage (ShaderStage::Fragment) is not in the binding visibility in
> the layout (ShaderStage::Vertex)" the first time a Flat material
> primitive rendered in a scene with the LUT active. Default scenes
> had the LUT placeholder off so this stayed latent.
>
> Always VERTEX_FRAGMENT — the visibility flag is free at runtime
> and protects against any future shader (Lit or Flat) adding a
> fragment-side camera read.

Kept because the two failures depend on runtime material and atmosphere choices
and are not apparent from the common bind-group shape.

### `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts` — `PrimitiveCommandCache` OIT fields

_Moved 2026-08-21._

> C11-157 Slice A — attach the OIT accumulation variant inputs to
> translucent color commands. `executeTranslucentPass` auto-builds the
> MRT pipeline from `_shaderCode` + `_pipelineConfig` ONLY when the
> FAR-003 `_webgpuOITEnabled` gate is on; both fields are otherwise inert
> (never read), so the sorted-alpha default path is byte-identical. The
> OIT pipeline reuses the primitive's SHARED layout (bind-group
> compatibility) and the base cull mode. It is single-sample to match the
> single-sample OIT accumulation targets — MSAA×OIT accumulation stays
> the pre-existing FAR-003 adjacency (NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING).

Kept because dormant cache fields and the sample-count boundary are retained
infrastructure, not dead state.

### `packages/engine/Source/Renderer/WebGPU/WebGPUResidentInstanceBuffer.ts` — `WebGPUResidentInstanceBuffer`

_Moved 2026-08-21._

> Resident-instance partial-write manager for the WebGPU collection
> renderers (Phase 1 of the Large Dynamic Objects roadmap —
> NEW-RESIDENT-INSTANCE-BUFFER-MGR + NEW-PARTIAL-WRITE-COALESCING).
>
> Keeps a resident CPU `Float32Array` of packed per-instance data plus a
> GPU vertex buffer between frames, so:
>   - a STATIC collection uploads NOTHING per frame, and
>   - a sparse change re-packs + uploads ONLY the changed instances'
>     byte ranges (O(changed), not O(N)).
>
> The load-bearing invariant is the slot map: the GPU slot is the running
> COMPACTED visible order (over `show` + `_clusterShow`), NOT the
> primitive's dense `_index`. Hidden primitives get no slot. Any event
> that can shift downstream slots — add / remove / show-toggle /
> clusterShow change / length change — must force a FULL rebuild (whole
> CPU re-pack + one writeBuffer + slot-map recompute). Only a property
> edit on an already-visible instance whose slot is unchanged takes the
> partial path. Getting this predicate wrong is exactly how the Batch 226
> all-or-nothing gate shipped stale renders (see DEFERRED_WORK
> NEW-COLLECTIONS-DIRTY-GATE).
>
> Velocity prev-mirror (TAA motion vectors): when `mirrorPrev` is set the
> manager maintains a second GPU buffer holding LAST frame's data at the
> SAME slots. On partial writes the prev slot is mirrored before the
> current slot is overwritten, and slots written at frame N are caught up
> at frame N+1 (so a one-frame move produces exactly one frame of
> non-zero velocity, then settles). On full rebuilds prev = current
> (zero velocity for the rebuild frame — slots may have shifted, so
> mapping old slots forward would be wrong).
>
> Consumers: billboard (Batch 229), point + label (Batch 232 —
> NEW-PARTIAL-WRITE-WIRE-BPL complete). The label wiring deliberately
> forces the full-rebuild path on ANY glyph dirty (glyph dirty
> granularity is unsound for per-slot writes — see the GRANULARITY NOTE
> in WebGPULabelRenderer); settled label frames still upload nothing.
> Folding into NEW-COLLECTION-RENDERER-BASE is P1-T6.
>
> @private
> @module WebGPUResidentInstanceBuffer

Kept because the standalone shape is an intentional ownership boundary and the
missing-slot response is a safety rule rather than optional error recovery.

### `packages/engine/Source/Renderer/WebGPU/WebGPUModelInstancing.js` — instance feature-ID lane

_Moved 2026-08-21._

> Only transport IDs that key a property table — the sole consumer of the
> instance-sourced `featureId0` varying today. Batch styling / feature pick
> for instanced tilesets is a future extension of this same data path.

Kept because an unread lane can look removable even though it is the explicit
compatibility boundary for unfinished consumers.
