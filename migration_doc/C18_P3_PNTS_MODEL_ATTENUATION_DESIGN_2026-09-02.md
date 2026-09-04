# C18-P3 — PNTS model-path attenuation and `pointSize`: diagnosis and design

**Lane:** Leofa · **Date:** 2026-09-02 · **Row:** `C18-P3` in
[QUEUE_2026-08-09_CAMPAIGN18.md](QUEUE_2026-08-09_CAMPAIGN18.md) (Wave P)

**Verdict: the row's premise is CONFIRMED, and the fix does not fit one lane.**
This document is the diagnosis, the mechanism, the recommended design and the
slice plan. The Edge leg is authored and landed with it
(`Tools/visual-regression/probe-pnts-model-attenuation.mjs`); no engine file is
touched.

---

## 1. Premises, re-derived from the code

Every claim below was read at the cited line in this working tree, not carried
from the row or from `DEFERRED_WORK.md`.

### 1.1 All PNTS content really does run through the Model pipeline

- `packages/engine/Source/Scene/Model/Model.js:3284` constructs a `PntsLoader`,
  so a `.pnts` tile is a `Model`.
- `packages/engine/Source/Scene/Model/Model3DTileContent.js:511` hands the
  tileset's `PointCloudShading` instance to that model
  (`pointCloudShading: tileset.pointCloudShading`).
- The separate `Scene/PointCloud.js` renderer — the one the dedicated WebGPU
  point-cloud path serves — is imported by exactly one file,
  `Scene/TimeDynamicPointCloud.js`. It never sees a PNTS tileset.

So the settings a user sets on `tileset.pointCloudShading` reach the Model
pipeline, and only the Model pipeline.

### 1.2 What WebGL does with them

- `Scene/Model/ModelRuntimePrimitive.js:305` pushes
  `PointCloudStylingPipelineStage` when the primitive has point-cloud style.
- `Scene/Model/PointCloudStylingPipelineStage.js:121` adds the
  `HAS_POINT_CLOUD_ATTENUATION` define; `:145` declares the `vec4`
  `model_pointCloudParameters`; `:151` appends `PointCloudStylingStageVS`.
- `PointCloudStylingPipelineStage.js:154-199` packs the vec4:
  - `x` = `maximumAttenuation ?? defaultPointSize` (`5.0` for ADD refinement,
    else `tileset.memoryAdjustedScreenSpaceError`), times `frameState.pixelRatio`;
  - `y` = `getGeometricError(...) * geometricErrorScale`, where
    `getGeometricError` (`:204`) prefers `tile.geometricError`, then
    `pointCloudShading.baseResolution`, then a cube-root-of-volume estimate;
  - `z` = `drawingBufferHeight / camera.frustum.sseDenominator`, or
    `+Infinity` in 2D / orthographic;
  - `w` = `tileset.timeSinceLoad`.
- `Shaders/Model/PointCloudStylingStageVS.glsl:1-9` is the whole formula:
  `min((geometricError / -positionEC.z) * depthMultiplier, pointSize)`.
- `Shaders/Model/ModelVS.glsl:144-156` selects the size —
  custom-shader `pointSize`, else the style/attenuation stage, else
  `u_pointDiameter`, else `1.0` — and multiplies by `show`.
- `Shaders/Model/ModelFS.glsl:72-78` carves a circle **only** under
  `HAS_POINT_DIAMETER`. Attenuated points are **solid squares** on WebGL, which
  is the shape WebGPU has to reproduce.

### 1.3 What WebGPU does with them: nothing

- `Renderer/WebGPU/WebGPUModelTopology.ts:125-134` maps `PrimitiveType.POINTS`
  to `point-list` with `synthesizesIndices: true`. WebGPU has no
  `gl_PointSize`, so `point-list` rasterizes exactly one pixel per point.
- `grep -n "pointCloud\|pointSize"` over
  `Renderer/WebGPU/WebGPUModelRenderer.ts` (9,284 lines) and
  `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (4,325 lines) returns **no**
  point-cloud or point-size symbol. There is no uniform, no shader code and no
  pipeline axis: the settings are read by nothing.
- `Shaders/WebGPU/Model/ModelPointCloudStylingStage.wgsl` is 25 lines that
  select between a default and a style colour/size. It does not contain the
  attenuation formula, and it is imported by nothing except the generated-source
  list at `scripts/__tests__/shaderSourceToJavaScript.spec.mjs:60`.

The row's wording is therefore accurate, with one correction: the orphaned WGSL
file is not a half-wired styling stage, it is a **stub that never had the
attenuation math in it**. Finishing the scaffolding means writing the formula,
not connecting an existing one.

### 1.4 A stale citation, surfaced not fixed

The `C18-P3` row and `DEFERRED_WORK.md:1273`
(`PNTS-MODEL-PATH-EDL-INERT`) both point at "the entry near line 9285" for the
do-not-remove scaffolding record. Line 9285 is inside
`NEW-GBUFFER-MRT-INTEGRATION`. The real record is
**`GLTF-PRIMITIVE-MODE-RESIDUALS`** (heading at `DEFERRED_WORK.md:9831`, item 3
at `:9839`), which says the orphan "does NOT map cleanly onto point-list" and
stays as scaffolding for quad expansion. Both citations should be re-pointed at
the entry **name**; a line number in a 10,000-line ledger drifts by
construction. Left unedited here to avoid colliding with other lanes in a
heavily contested file.

---

## 2. The mechanism the fix needs

WebGPU has no point size, so a sized point is a **quad**: six vertices per
point, offset in clip space by the computed pixel size. The fork already does
this in four places — `WebGPUPointCloudRenderer` (the dedicated PNTS path),
`Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl`,
`Shaders/WebGPU/Compute/ComputeInstanceRender.wgsl` and
`WebGPUGaussianSplatRenderer` — so the technique is settled. What is not
settled is how to get six vertices per point out of the **Model** pipeline,
whose vertex layout is built for one vertex per vertex.

Two candidate mechanisms exist. Both need the corner index from
`@builtin(vertex_index)` and the point index from `@builtin(instance_index)`,
both of which `ModelPBRComplete.wgsl:724-726` already declares.

An indexed draw cannot do it: with `drawIndexed`, `@builtin(vertex_index)` is
the *index value*, so six indices pointing at one point give six identical
vertices and a degenerate quad. The draw has to be non-indexed
`draw(6, pointCount)`, which `WebGPUDrawCommand.ts:704-712` already reaches
whenever a command carries `vertexCount` and no index buffer.

### Design A — instance-step vertex buffers (RECOMMENDED)

Bind the point's real attributes with `stepMode: "instance"` and draw
`(6, pointCount)`. Each of the six vertices sees the same point; the corner
comes from `vertex_index`.

The obstacle is the missing-attribute slots. `WebGPUModelRenderer.ts:7011-7046`
binds `primCache.normalBuffer || pipelineCache.defaultNormalBuffer` and so on,
and `WebGPUModelDeviceResources.ts:266-301` makes each default a **one-element**
buffer holding a non-zero value (`normal (0,1,0)`, `tangent (1,0,0,1)`,
`color (1,1,1,1)`). A one-element buffer cannot back an instance-step slot at
`instanceCount = N`, and a shared zero buffer cannot alias defaults that are not
zero. So:

- slots the primitive really has → `stepMode: "instance"`;
- slots on a default → stay `stepMode: "vertex"`, with a **six-element** default
  buffer (a new resource; enlarging the existing one-element defaults would
  change what every indexed model reads at vertices 1-5, where robust access
  currently returns zero).

That makes the vertex layout depend on which attributes are present — a new
pipeline axis. It fits the existing plumbing well: `ModelTopologyRealization` is
computed once per primitive (`WebGPUModelTopology.ts:436`), is threaded to all
twelve pipeline builders already, and is folded into the pipeline key by
`buildModelTopologyVariantKey` (`:626`), which **returns the key unchanged for
`triangle-list`** — so every triangle model keeps a byte-identical key.

The decisive advantage: **the WGSL vertex inputs do not change.** All nine
locations stay declared and stay bound, so `VertexInput`, the morph, skinning
and instancing blocks and the velocity block are untouched. The only shader
change is one `//>>ifdef` block near the end of `vertexMain`, in the exact shape
of the `MODEL_SILHOUETTE` block at `ModelPBRComplete.wgsl:1078-1095`, which
already rewrites `output.position` from pad-lane uniforms.

### Design B — storage-buffer vertex pulling (REJECTED)

Bind position and colour as storage buffers, index them by `instance_index`, and
build the point pipelines with `buffers: []`. This deletes the attribute-presence
axis and the six-element defaults, but a pipeline with no vertex buffers cannot
have a shader that declares `@location(0..8)`. Every location declaration, and
every block that reads one — morph, skinning, instancing and their previous-frame
twins — would have to be stripped under the define. That is broad surgery on the
vertex stage of the engine's hottest shader, in exchange for avoiding a
mechanical layout change. It also needs two more group-2 storage bindings, which
changes the bind-group layout for every model, and `STORAGE` usage on point
vertex buffers.

Design A is the smaller blast radius and the one this document specifies.

---

## 3. Design A in detail

### 3.1 Uniforms

Two free lanes exist in the material UB, both written zero by
`packMaterialUniforms`:

- `_pad_se0`, floats 120-123 (`WebGPUModelRenderer.ts:2279-2282`)
- `_pad_an0`, floats 128-131

Lane one carries WebGL's vec4 verbatim: `pointSize`, `geometricError *
geometricErrorScale`, `depthMultiplier`, `tilesetTime`. Lane two carries the
clip-space scale the quad expansion needs, `(2 / viewportWidth,
2 / viewportHeight, 0, 0)`.

The viewport is **not** otherwise reachable from the model shader. `CameraUniforms`
(`ModelPBRComplete.wgsl:75-102`) has no viewport, and `effects.edgeViewport.xy`
is written `1.0, 1.0` whenever edge detection is off
(`WebGPUEffectsBindGroup.js:1593-1594`), so it cannot be borrowed. The second
lane is required.

Both are float32 lanes inside the existing 768-byte buffer, so the UB does not
grow and a model with shading off packs the same bytes it packs today.

### 3.2 Shader

One block at the end of `vertexMain`, after `output.position` is final and
before the `LOG_DEPTH` block, gated by a new hi-word define:

```wgsl
//>>ifdef MODEL_POINT_CLOUD_ATTENUATION
// Six vertices per point; the corner comes from vertex_index. WebGL's
// gl_Points rasterize as solid squares (ModelFS.glsl carves a circle only
// under HAS_POINT_DIAMETER), so the quad is not carved either.
let pointSizePx = min(
  (material._pad_se0.y / max(-output.positionEC.z, 1e-6)) * material._pad_se0.z,
  material._pad_se0.x);
let corner = QUAD_CORNERS[input.vertexIndex];
output.position = vec4<f32>(
  output.position.xy + corner * pointSizePx * 0.5
    * material._pad_an0.xy * output.position.w,
  output.position.zw);
//>>endif
```

`min` against an infinite `depthMultiplier` reproduces the 2D/orthographic case
without a branch, exactly as the GLSL does.

### 3.3 The define

`ShaderDefine`'s lo word is **full**: `WebGPUShaderDefines.ts:22-32` records that
bits 0-30 are claimed and bit 31 is permanently reserved. The new bit is a
`ShaderDefineHi` entry (`:931`), which means threading `definesHi` into the model
module cache. That channel does not exist today: `_composeColorSource`
(`WebGPUModelPipelineCache.ts:2580`) computes only a lo-word `effectiveDefines`,
and `_getOrCreateShaderModule` (`:2784`) calls `getOrCreate(..., keySalt)` at
`:2808` with no hi word. There are exactly two callers of the composer (`:2800`,
`:2847`), so this is one contained addition — but it is an addition, and it must
also enter the local `moduleKey`.

### 3.4 The eligibility gate

Expansion applies when the primitive is `POINTS`, point-cloud shading is on, and
the primitive has none of GPU instancing, skinning or morph targets. The reason
is `input.vertexIndex`: under expansion it is the corner, not the vertex, so the
morph lookups at `ModelPBRComplete.wgsl:874` and `:993` would read the wrong
delta, and `instance_index` is the point, not the instance. An ineligible
primitive keeps today's `point-list` path — that is not a regression, it is
exactly what ships now, and it must be recorded as a documented partial rather
than left to be discovered.

### 3.5 Byte-identity when shading is off

Three independent reasons, all structural:

1. `buildModelTopologyVariantKey` returns the key unchanged for `triangle-list`,
   so no triangle pipeline's key moves.
2. The define is off, so the preprocessor emits the module it emits today.
3. The pad lanes stay zero, so the material bytes are the ones packed today.

The probe's identity leg is the empirical half: it publishes the sha256 of the
shading-off captures so a pre-change and post-change run can be compared
directly.

### 3.6 The edit list

| File | Edit |
|---|---|
| `Renderer/WebGPU/WebGPUShaderDefines.ts` | one `ShaderDefineHi` entry, add-only |
| `Renderer/WebGPU/WebGPUModelTopology.ts` | expansion + step-mask fields on `ModelTopologySpec` / `ModelTopologyRealization`; fold both into `modelTopologyAxisToken`; skip index synthesis for an expanded primitive |
| `Renderer/WebGPU/WebGPUModelPipelineCache.ts` | per-slot `stepMode` in `createVertexBufferLayout` (`:735`) and its twelve call sites (`:926, 1071, 1142, 1378, 1469, 1529, 1597, 1656, 1739, 1829, 1897, 1983`); `definesHi` through `_composeColorSource` and `_getOrCreateShaderModule` |
| `Renderer/WebGPU/WebGPUModelDeviceResources.ts` | six-element companions to the six default attribute buffers |
| `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` | the one `//>>ifdef` block; the pad-lane comments |
| `Renderer/WebGPU/WebGPUModelRenderer.ts` | pack the two lanes with WebGL's formula; `vertexCount: 6`, `instanceCount: pointCount`, no index buffer for expanded primitives; pick the right default buffers |
| `Shaders/WebGPU/Model/ModelPointCloudStylingStage.wgsl` | either becomes the real chunk the block includes, or is retired against its ledger entry — do not leave it a stub |

### 3.7 Slice plan

- **P3-a** — the axis with no consumer: hi-word define, `definesHi` threading,
  the realization fields, the layout `stepMode` parameter and the six-element
  defaults, with the flag never set. Provable by a spec over the key builder and
  the layout builder, and byte-identical by construction.
- **P3-b** — the shader block, the pad-lane packing and the draw arguments; the
  probe's liveness verdict turns green on WebGPU here.
- **P3-c** — parity: the `show` multiply, `u_pointDiameter` (also inert on
  WebGPU today, same mechanism), and the pick/velocity/CSM commands, which share
  the draw arguments and therefore need checking rather than porting.

One lane per slice. This lane's judgement is that P3-a and P3-b are not safely
one patch, in the two largest files in the renderer, without a build.

---

## 4. Open questions the implementing lane must settle first

1. Does `WebGPUCSMCastPass.ts:807-810` receive the expanded command's counts,
   or does the shadow path rebuild them? Points casting shadows as quads is a
   change from today's 1 px.
2. Does any of the twelve builders call `createVertexBufferLayout` without the
   realization in scope?
3. Does the pick pipeline need the same expansion to keep a picked point
   clickable at its rendered size? Today pick is 1 px, so this is an
   improvement, not a regression — but it should be a decision, not a
   side effect.
4. `PointCloudStylingPipelineStage` also handles the point-size *style*
   expression (`HAS_POINT_CLOUD_POINT_SIZE_STYLE`), which takes priority over
   attenuation on WebGL. That is `C11-86` and stays there; the WebGPU shader
   block should be written so the style value can feed the same slot later.

---

## 5. The Edge leg

`Tools/visual-regression/probe-pnts-model-attenuation.mjs`, landed with this
document. It loads `/Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudRGB/`
with the globe, sky and FXAA removed, at three camera distances (10 m, 25 m,
60 m), under three shading configurations (off, `maximumAttenuation` 4,
`maximumAttenuation` 16), on both backends, and counts lit pixels.

- **Liveness** — the footprint must grow when `maximumAttenuation` goes 4 → 16.
  Evaluated on **both** backends from the same captures: WebGL is the control,
  and a run where the WebGL verdict fails is a broken measurement, not a green
  backend.
- **Parity** — the WebGPU/WebGL lit-pixel ratio at each distance. Flagged
  `provisional`: the 1.35 bound has never been confirmed by a paired green run,
  and until one exists it is a reading, not a promotion limit.
- **Identity** — the shading-off captures publish their sha256; a run with
  `--baseline-receipt` compares them against a receipt banked from the earlier
  build. Without a baseline the verdict records `pending-baseline` and does not
  pass, so a run that never made the comparison cannot read as one that did.
- **Errors** — GPU validation faults, console faults and device loss fail
  their cell.

Run it before the change to bank the baseline, then after with
`--baseline-receipt`:

```
node server.js --port 8094 --serve-built
node Tools/visual-regression/probe-pnts-model-attenuation.mjs
node Tools/visual-regression/probe-pnts-model-attenuation.mjs \
  --baseline-receipt Tools/visual-regression/output/pnts-model-attenuation/pnts-model-attenuation.json
```

The verdict layer runs browser-free in
`Tools/visual-regression/pnts-model-attenuation-verdicts.spec.mjs`
(runner home: `npm run test-visual-probe-contracts`).

**Expected today, and the reason the probe exists:** `liveness/webgl` passes,
`liveness/webgpu` fails at ratio 1.0, and every attenuated parity cell is red.
