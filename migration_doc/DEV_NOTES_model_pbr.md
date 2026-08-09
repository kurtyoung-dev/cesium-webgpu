# DEV notes — model / PBR / IBL

Comments moved out of `packages/*/Source` by the Campaign 16 comment
remediation, preserved verbatim. Format:
[DEV_NOTES_FORMAT.md](DEV_NOTES_FORMAT.md). These are historical records, not
current documentation — verify any claim here against the code before acting
on it.

Scope: the C16-08 shard — the WebGPU model renderer and its pipeline cache, the
model WGSL (PBR, styling, silhouette, splitter, atmosphere, error fallback), the
BRDF LUT and spherical-harmonic IBL producers, structural-metadata WGSL, and the
fork-touched `Scene/Model/` pipeline stages and glTF loader.

### `packages/engine/Source/Shaders/WebGPU/Compute/ProjectRadianceToSH.wgsl` — (module docblock)

_Moved 2026-08-09._

```text
ProjectRadianceToSH.wgsl — Radiance Cubemap → Spherical-Harmonic (L2) Projection

NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354). WebGPU parity for
the WebGL diffuse-IBL SH path. WebGL feeds a model's diffuse IBL via 9
atmosphere-derived SH-L2 coefficients (czm_sphericalHarmonics); WebGPU
previously had no SH producer, so models fell back to sampling the
irradiance cubemap — a ~20-30% different energy reconstruction (worst
in blue), reading as a +15% luminance / +24% blue overbright vs WebGL.

This is a byte-faithful transcription of the WebGL projection in
`ComputeIrradianceFS.glsl` (computeShBasis + the 256-sample Monte-Carlo
loop), INCLUDING WebGL's `(-x, -y, z)` cube-lookup flip
(ComputeIrradianceFS.glsl:94-95). NEW-MODEL-IBL-AMBIENT (re-land of the
audited-GO B3 fix): the Batch-354 claim that raw-direction sampling was
an intentional backend difference was NUMERICALLY DISPROVEN — a JS
re-projection of the live WebGPU radiance cube at the 256 Hammersley
directions WITH the flip reproduces WebGL's measured SH c1 blue
coefficient (0.151 vs 0.152), while raw sampling gives 0.029 (5x short
on the sky-blue directional band = the olive model tint). The flip is
required for parity.

One backend-specific difference that IS intentional:

  Output is written straight into a storage buffer (9 vec4 + a
  control vec4) instead of WebGL's 3×3 render-to-texture + readback.
  The same buffer is bound as the model's `SHUniforms` uniform
  (binding 36) — no CPU round-trip.

Energy: the WebGPU radiance cube already bakes `atmosphereScatteringIntensity`
(ProceduralSkyCubemap.wgsl:295), exactly as WebGL's radiance map does
(ComputeRadianceMapFS.glsl:85, `.w` = atmosphereScatteringIntensity).
WebGL then multiplies the projected coeffs by atmosphereScatteringIntensity
AGAIN (DynamicEnvironmentMapManager.js:979) — a deliberate double-apply.
`params.intensity` carries that second multiply so the result matches.

Dispatch: 1 workgroup of 9 invocations — invocation i computes coeff i.
```

Kept for the refuted design and its numbers: raw-direction sampling was once
recorded as a deliberate backend difference, and the measured re-projection
(0.151 with the flip, 0.029 without, against WebGL's 0.152) is the only written
record of what disproved it. The rewritten comment states the constraint and
keeps the measurement; this preserves the source-line pointers that were
dropped because they rot.

### `packages/engine/Source/Renderer/WebGPU/WebGPUModelTopology.ts` — (module docblock)

_Moved 2026-08-09._

```text
WHY THIS MODULE EXISTS
----------------------
Before C11-90 the model path recognized exactly two of glTF's seven draw
modes. `topologyForPrimitiveType` mapped mode 0 (POINTS) to `"point-list"`
and *everything else* — LINES, LINE_LOOP, LINE_STRIP, TRIANGLE_STRIP,
TRIANGLE_FAN — to `"triangle-list"`. Those five modes did not merely render
imprecisely; they rendered a completely different mesh from the same index
list (a LINE_STRIP's `[a,b,c,d,e,f]` became two unrelated triangles). The
`KHR_mesh_primitive_restart` merge (upstream `65a194d24e`) brought concrete
line-strip / line-loop / triangle-strip / triangle-fan assets into the tree,
so the gap is reachable parity debt rather than a hypothetical.

The Batch-788 globe lesson (`WebGPUGlobeSurfacePipelineKey.ts`) is the reason
this is a MODULE and not five `switch` statements: a pipeline-key axis that
lives in more than one place drifts, silently, for as long as nothing can
observe the drift.

FEATURE PRESERVATION
--------------------
TRIANGLES and POINTS are byte-identical to their pre-C11-90 behavior:
TRIANGLES yields {@link MODEL_TOPOLOGY_TRIANGLE_LIST} (whose variant key is
the base key UNCHANGED, so every already-cached triangle pipeline keeps its
key), and POINTS yields point-list plus the same sequential-index synthesis
the GLTF-POINTS-MODE batch introduced.
```

Kept for the defect this module was built to close — five of glTF's seven draw
modes silently rendering a different mesh from the same index list — and for the
upstream commit that made those assets reachable. The rewritten comment keeps
the two-field-axis constraint and the aliasing argument; the historical "before"
state and the globe precedent that motivated the module shape live here.

### `packages/engine/Source/Renderer/WebGPU/WebGPUModelCameraArena.ts` — (module docblock)

_Moved 2026-08-09._

```text
Before this module every model wrote its 320-byte RTE camera block into a
PERSISTENT per-model (and per-transformed-node, and per-2D/IDL-duplicate)
`GPUBuffer` with one `device.queue.writeBuffer` call each, every frame,
unconditionally. A scene with `M` models and `N` transformed nodes paid
`M * (1 + N)` queue writes per frame — plus a second `M * N` for the SCENE2D
IDL duplicate — even when nothing but the camera moved. The environment
capture path avoided the persistent buffers (it must, because the main pass
reads them later in the same frame) but paid a fresh `createBindGroup` per
primitive per cube face instead.

The light block was worse: it was packed, byte-compared, and uploaded once
PER PRIMITIVE (`primCache.lightBuffer`) even though every primitive of a
model packs byte-identical contents. An `N`-primitive model paid `N` packs
and — because camera-relative light positions change whenever the camera
moves — `N` real uploads per frame, with the unchanged-write suppression
that guarded them succeeding only while the camera was perfectly still.

[…]
This is exactly the shape proven for the globe by
NEW-GLOBE-DYNAMIC-OFFSET-UBO (Batch 292).
[…]
  2. Give the light its own bind group. Impossible: models already occupy
     groups 0-3 and Chromium-on-Windows caps `maxBindGroups` at the spec
     floor of 4 (the Batch-152 opt-up was reverted for exactly this).
```

Kept for two things the rewritten comment cannot carry. The first is the
measured cost model of the design this arena replaced (`M * (1 + N)` queue
writes per frame, plus `M * N` again for the IDL duplicate, and one light pack
and upload per primitive) — the numbers that justify the arena's existence, not
its behaviour. The second is the specific reason `maxBindGroups` cannot be
assumed above 4: an opt-up was tried and reverted on Chromium/Windows, so a
future reader proposing a fifth bind group is re-proposing something already
refuted.

### `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js` — `extractPrimitiveGeometry` (UNSIGNED_BYTE index upcast)

_Moved 2026-08-09._

```text
glTF allows UNSIGNED_BYTE indices (componentType 5121), and
CZML Model Articulations is one of the few production assets
that ships them — the hinge meshes for the cesium_air control
surfaces compile down to 18 byte-indices each.
[…]
(Symptom pre-fix on the
CZML Model Articulations demo: `Index range (first: 0,
count: 18, format: Uint16) does not fit in index buffer
size (20)` warning every frame, model never renders.)
Session 65 Batch 7 (2026-05-12) — NEW-VR-CZML-MODEL-
ARTICULATIONS-INDEXCOUNT.
```

Kept for the reproduction case. UNSIGNED_BYTE indices are rare enough that the
upcast looks like dead defensiveness; the note records which shipped demo
actually exercises it (CZML Model Articulations, the `cesium_air` control-surface
hinges at 18 byte-indices each) and the exact validation message the missing
upcast produces, so a future reader can re-trigger the defect rather than
re-deriving it.

### `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — `perturbNormal` (tangent-less NaN guard)

_Moved 2026-08-09._

```text
── Screen-space derivative tangent frame (Slice 5d Batch 159) ──────────
`derivedTangent` is the raw tangent + UV-jacobian determinant computed
by `deriveTangentRaw` at the uniform entry of `fragmentMain`. This is
the fallback for the case diagnosed in Batch 153: a glTF primitive can
declare a normal texture WITHOUT a TANGENT vertex accessor. The vertex
path then computes `tangentEC = normalize(normalMatrix * tangentMC)`
over a zero tangent → `normalize(vec3(0))` → NaN, so the tEC/bEC
reaching this function are NaN (not zero). Batch 153 fell back to the
flat geometric normal (lighting stayed correct but lost all normal-map
surface detail); this orthogonalizes the derived tangent against N and
takes `B = cross(N, T)` — byte-for-byte WebGL's computeTangent path —
so the detail is preserved with matching handedness. No derivatives
here: they were already taken in uniform control flow upstream.

NaN-safe degeneracy test: `length(NaN)` is NaN and `NaN > 1e-4` is
false, so `!(len > 1e-4)` catches BOTH the zero-length case (len == 0)
AND the NaN case. A plain `len < 1e-4` would miss NaN (`NaN < 1e-4` is
also false) — the bug the Batch 153 guard originally had.

No usable vertex tangent — use the derived screen-space frame.
Guard degenerate UV derivatives (det ≈ 0 → tRaw is non-finite): with
no UV gradient there is no recoverable tangent, so keep the flat
geometric normal (the Batch 153 behavior) rather than emit a NaN.
```

Kept in full because this guard has been got wrong once already and the failure
is silent: a normal-mapped glTF primitive with no TANGENT accessor produces a
NaN normal, which zeroes all lighting rather than erroring. The two-stage
history matters — the first fix fell back to the flat geometric normal and lost
normal-map detail, and its `len < 1e-4` test did not catch NaN at all. The
rewritten comment states the polarity rule (`!(len > 1e-4)`, never
`len < 1e-4`); this preserves the wording that explains why a reader must not
"simplify" it back.

### `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — `fragmentMain` (ambient / IBL)

_Moved 2026-08-09._

```text
NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY (D2): the previous
`+ light.ambientColor * diffuseColor * 0.05` term was a non-physical
floor WebGL does not have; it brightened/flattened the at-rest neutral
model relative to WebGL. Removed for parity. No fallback floor is needed
even when IBL is unconfigured: `diffuseIBL`/`specularIBL` always sample a
cubemap (the mid-grey placeholder when no environment is generated — see
the placeholder IBL bind-group entries in WebGPUModelRenderer.js), so the
ambient is never silently black. Gating a floor on `light.iblHasSH` would
re-introduce a code path WebGL lacks and reproduce the same divergence in
the SH-less case, so it is deliberately omitted.
```

Kept because the absent term is the point. A reader comparing this path against
an engine that does carry an ambient floor will be tempted to add one back; this
records that a `0.05` floor was present, measured against WebGL, and removed for
parity, and that the `light.iblHasSH` gating variant was considered and rejected
for the same reason.

### `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts` — `createVelocityPipeline`

_Moved 2026-08-09._

```text
Batch 143 — drop multisample. The velocity pass attaches the
single-sample velocityTexture (per WebGPUSceneFramebuffer.ts:118)
as the only color attachment, so the pipeline must also be
single-sample to match. Pre-Batch-143 this baked
`{count: sampleCount}` (= 4 when scene MSAA is on) which would
trigger a sampleCount-mismatch validation error the moment Model
started emitting velocity commands. This IS now live (TAA-SLICE-2B,
premise-reconciled 2026-07-05): Model primitives DO tag
`.velocityCommand` when `frameState.taaEnabled` (WebGPUModelRenderer
L4967), and `probe-model-taa-msaa.mjs` now reports 1/80 velocity
commands with 0 device errors — the TAA→MSAA=1 coupling in
`prepareFrame` keeps the velocity pass's single-sample attachments
valid against scene depth, so this single-sample pipeline is the
correct match. Do NOT re-add `{count: sampleCount}` here.

Matches the collection renderers' velocity pipelines (Batch 134)
which all leave multisample undefined for the same reason.
```

Kept because the code reads as an oversight: the function takes a `sampleCount`
parameter and then deliberately voids it, so a reader tidying up is likely to
"restore" `{count: sampleCount}` and reintroduce a validation error that only
fires once a model actually emits a velocity command. The note records the
measured evidence that the path is live (1 of 80 commands carrying velocity, 0
device errors) and the `prepareFrame` TAA-to-MSAA=1 coupling that makes
single-sample the correct match.
