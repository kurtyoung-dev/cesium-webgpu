# WebGPU ↔ WebGL Feature-Parity Report — 2026-06-30

> **POINT-IN-TIME, CODE-GROUNDED SNAPSHOT.** This report is a synthesis of seven
> per-subsystem surveys taken against `main` at **HEAD = Batch 458**
> (`baa3f62d43`, "DP-H46d — property-TABLE structural-metadata read"). Every status
> below is anchored to a specific file/line, a shipped batch, or an explicit
> `DEFERRED_WORK.md` / `FEATURE_INVENTORY.md` entry. Status labels drift as batches
> land; re-run the surveys before quoting these numbers in a later session.
>
> **DP-H46 metadata epic is mid-flight.** Display-side structural-metadata read
> (DP-H46 a/b/c/d) shipped in Batches 454–458. The **metadata-pick producer
> (DP-H46e)** is the in-progress piece this session and is counted as *partial* in
> both the 3D-Tiles and Picking tallies below.

---

## 1. Methodology

Seven subsystem surveys were performed, each enumerating concrete features and
assigning one of four WebGPU statuses against the WebGL baseline:

| Status | Meaning |
| --- | --- |
| **full** | Real implementation at WebGL parity (or exceeding it); verified by probe, shipped-batch reference, or code inspection. |
| **partial** | Works for the common case but has a documented gap (a missing variant, a scene-mode hole, an HDR/precision edge, or verification-only debt). |
| **stub** | Intentional no-op / placeholder scaffold; the consumer half exists but the producer half (or the entire data path) is unimplemented. |
| **missing** | No WebGPU implementation; deferred, gated, or research-stage. |

Backend-agnostic CPU-side code (terrain providers, imagery providers, DataSource
loaders, property evaluators, tile traversal) is counted **full** because it is
shared by both backends and needs no renderer-specific work — this matches how the
fork's own inventory scopes parity.

### Parity definitions used

Three numbers are reported because "parity" has three honest readings:

- **Strict** = `full / total`. Counts only fully-shipped features. Pessimistic
  (a one-line verification-probe gap drops a feature out of the numerator).
- **Weighted** = `(full + 0.5 × partial) / total`. Gives half-credit to partials,
  most of which are display-correct with a narrow hole. **This is the headline
  number** — it best reflects "how much actually works for a user today."
- **Generous** = `(full + partial) / total`. Counts anything that renders
  correctly in the common case. Optimistic upper bound.

A fourth, **adjusted** number excludes the 8 `missing` features that are
*deferred-by-design* (research-stage, future enhancements, or micro-optimizations
that carry no user-visible benefit today — VSM/ESM, linear-depth cast,
INTERSECTION-mode clipping, virtual-texture terrain, etc.). These were never
scheduled for near-term parity, so charging them against the denominator
understates how complete the *intended* surface is.

---

## 2. The Parity Number

| Definition | Formula | Result |
| --- | --- | --- |
| **Strict** | 220 / 255 | **86.3 %** |
| **Weighted (headline)** | (220 + 0.5·23) / 255 | **90.8 %** |
| **Generous** | (220 + 23) / 255 | **95.3 %** |
| Adjusted strict (excl. 8 by-design `missing`) | 220 / 247 | 89.1 % |
| Adjusted weighted (excl. 8 by-design `missing`) | (220 + 11.5) / 247 | **93.7 %** |
| Adjusted generous (excl. 8 by-design `missing`) | 243 / 247 | 98.4 % |

**Bottom line: ~91 % weighted parity on the full surface (~94 % once
deferred-by-design items are excluded from the denominator).**

---

## 3. Per-Subsystem Tally

| # | Subsystem | full | partial | stub | missing | total | weighted % |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Globe & Imagery | 41 | 3 | 1 | 3 | 48 | 88.5 % |
| 2 | 3D Tiles | 27 | 6 | 1 | 1 | 35 | 85.7 % |
| 3 | glTF Models + KHR | 52 | 2 | 0 | 0 | 54 | 98.1 % |
| 4 | Geometry & Collections | 15 | 6 | 0 | 0 | 21 | 85.7 % |
| 5 | Picking / Shadows / Lighting | 18 | 3 | 1 | 4 | 26 | 75.0 % |
| 6 | Post-process & Effects | 34 | 2 | 1 | 0 | 37 | 94.6 % |
| 7 | Entity / DataSource + Perf | 33 | 1 | 0 | 0 | 34 | 98.5 % |
| | **TOTAL** | **220** | **23** | **4** | **8** | **255** | **90.8 %** |

**Strongest subsystems:** glTF Models (98 %), Entity/DataSource+Perf (98 %),
Post-process (95 %). **Weakest:** Picking/Shadows/Lighting (75 % weighted) — but
this is skewed by 4 deferred-by-design `missing` items (VSM/ESM, linear-depth cast,
tile-per-cascade WSM) plus the voxel-cell-pick stub; the *display-side* shadow and
pick paths are production-ready. 3D Tiles (86 %) and Geometry/Collections (86 %) are
dragged by the vector-tile Buffer\* 2D/CV holes and the voxel data-path stub.

---

## 4. Verdict vs. the "~93 %" claim

**Confirm, with a caveat — the honest headline is ~91 %, and ~93 % is the
upper-middle of a defensible range, not the median.**

- The fork's "~93 %" lines up almost exactly with the **adjusted weighted** number
  (**93.7 %**) — i.e., it is true *if* you give partials half-credit **and** drop
  the 8 deferred-by-design `missing` items from the denominator. Both are reasonable
  accounting choices, so the claim is not inflated, but it is the optimistic end of
  the band.
- On the **full, unadjusted surface** the weighted number is **90.8 %**, and the
  strict number is **86.3 %**. So if a reader interprets "93 % parity" as "93 % of
  features are fully done," that is **too high** — only **86 %** are fully shipped;
  another **9 %** are partial (work-for-the-common-case with a documented hole).
- **Recommended framing: "~91 % weighted parity (86 % fully-shipped + 9 % partial),
  ~94 % excluding deferred-by-design items."** That is the defensible, non-rounded
  statement. The single "93 %" headline is fine for a one-liner but should carry the
  full/partial split when precision matters.

The gap between 86 % (fully done) and 93–95 % is **the 23 partials** — features
that render correctly today but carry a scene-mode hole, an HDR edge case, a missing
variant, or verification-only debt. That band is exactly "the remaining 7 %"
the maintainer is asking about, plus the 12 stub/missing items below.

---

## 5. THE REMAINING GAP — Work to reach 100 %

35 features are not `full`: **23 partial + 4 stub + 8 missing.** Grouped by
subsystem, with what is specifically incomplete. Items marked **(by-design)** are
deferred/research/micro-opt — they are *not* near-term parity debt and explain why
the "adjusted" denominator drops them.

### 5.1 Globe & Imagery — 3 partial, 1 stub, 3 missing

| Item | Status | What's missing |
| --- | --- | --- |
| EquirectangularPanorama cull-override | partial | `WebGPUPrimitiveCommands.js` bakes `cullMode` from `appearance.closed` only; ignores `renderState.cull.enabled:false`. Panorama viewed from inside shows back-faces. (WGF-1 / C-R1-PRIMITIVE-DERIVED) |
| Hardware clip-distances (WGF-1) expansion | partial | Globe terrain has clip-distances; **primitives/models do not** (see stub + missing rows). |
| GlobeWater facade | partial | Facade + enhanced ocean are full; future water phases (classification, flow maps, caustics, refraction) deferred per `WATER_RENDERING_DESIGN.md §5`. **(by-design)** |
| Clipping planes on primitives | **stub** | Primitive shaders declare clip uniforms + struct fields but never write `@builtin(clip_distances)`. Deferred to WGF-1-EXPAND. |
| Clipping planes on glTF models | missing | `WebGPUModelRenderer.js` wires no clip-distance variant. WGF-1-EXPAND. |
| WGF-1 INTERSECTION-mode clipping | missing | Union semantics only. Future enhancement. **(by-design)** |
| Globe point/cube-light shadow receive | missing\* | globe-imagery survey lists this `missing` (C-R10-GLOBE-POINT-LIGHT), **but the Picking survey reports it RESOLVED (Batch 108, verified B190)** with 5-tap PCF. Cross-survey conflict → treat as **functionally resolved**; reconcile the inventory. |
| Water classification / WebNN super-res / virtual-texture terrain | missing | Header-listed future/research. **(by-design)** |

### 5.2 3D Tiles — 6 partial, 1 stub, 1 missing

| Item | Status | What's missing |
| --- | --- | --- |
| Voxels (VoxelPrimitive / VoxelContent) | **stub** | Entire data path unimplemented: `WebGPUVoxelRenderer.ts` ray-marches a hardcoded 4×4×4 gradient placeholder. No CustomShader→WGSL transpile, no megatexture/octree traversal, no per-cell pick. Upstream PR#13517 default-shader is unreachable (C-R9). **XL effort.** |
| ClassificationPrimitive (standalone) | partial | `CLASSIFICATION_PRIMITIVE` FR is a marker no-op; standalone primitive renders nothing on WebGPU. Vector3DTile classifiers (slots 42–44) are full. (CLASS-GPRIM-WEBGPU) |
| EXT_structural_metadata | partial | DP-H46a/c/d shipped; **DP-H46b multi-component attributes + full property-texture/feature-ID WGSL sampling audit (FEAT-3DT2-02)** pending. |
| Edge visibility (EXT_mesh_primitive_edge_visibility) | partial | Display modes + per-edge materialColor shipped (B316/330); **authored `silhouetteNormals` signed-byte accessor path** still re-derived from adjacency (can diverge from WebGL); PR#13421 degenerate-tri parity unconfirmed. |
| GeoJsonPrimitive | partial | Loader + Buffer\* renderers shipped; **no Playwright probe pixel-verifies hole/MultiPolygon triangle-count math** vs WebGL (verification debt only). |
| Vector-tile Buffer\* in 2D / Columbus View | partial | Buffer{Point,Polyline,Polygon} encode ECEF-RTE only; no CPU-reprojected ENU buffer → wander in 2D/CV. Low priority. |
| Hi-Z tile occlusion integration | partial | Hi-Z pyramid builds; consumes ViewportExecutor command lists, **not tile bounding volumes** yet (Phase-8a). |
| Per-tile CSM cascade culling | partial | Uniform cascade fit applied to all tiles; per-tile assignment deferred (CSM-DESIGN). |
| FEAT-3DT2-03 ellipsoid-aware RTE | partial | WGS84 radius constants hardcoded; **non-WGS84 tilesets (Mars/Moon) positionally wrong.** |
| BufferPrimitive positionNormalized / integer datatypes | missing | All three renderers assume DOUBLE positions; non-DOUBLE / normalized silently mis-encode. Needs snorm/unorm pipeline variant. Low priority. **(by-design)** |

### 5.3 glTF Models + KHR — 2 partial

| Item | Status | What's missing |
| --- | --- | --- |
| Custom Shaders (WGSL injection) | partial | GLSL `CustomShader` API exists but is **unused on WebGPU**; WGSL chunk-injection deferred (NEW-MODEL-WGSL-CUSTOM-SHADER). Today a no-op + warning. |
| Model metadata picking | partial | Display-side read shipped (DP-H46 a–d); **pick coordinator DP-H46e mid-flight this session.** |

### 5.4 Geometry & Collections — 6 partial

| Item | Status | What's missing |
| --- | --- | --- |
| Polyline / PolylineVolume primitive | partial | Core + appearances shipped (B343-344); **PolylineCollection 2D/Columbus View falls through to WebGL** (scene-mode morph pillar). |
| GroundPolylinePrimitive | partial | Full in 3D; **2D / CV / Morph fall through to WebGL.** |
| BufferPointCollection | partial | 2D/CV reprojection hole (alpha/blendOption/boundingVolume now SHIPPED B315). |
| BufferPolylineCollection | partial | 2D/CV support missing (alpha/blendOption shipped B315). |
| BufferPolygonCollection | partial | 2D/CV deferred; polygon **outline unimplemented on both backends** (alpha/blendOption shipped B315). |
| GeoJsonPrimitive | partial | Rides on Buffer\* renderers; **no pixel-verification probe** + `debugShowBoundingVolume` no-op. |

### 5.5 Picking / Shadows / Lighting — 3 partial, 1 stub, 4 missing

| Item | Status | What's missing |
| --- | --- | --- |
| Voxel per-cell pick (3× u32 cell coords) | **stub** | Cell coords don't fit in 4-byte pickColor; needs out-of-band cell-coordinate buffer + separate resolve. Primitive-level voxel pick works. (C-R9) |
| Metadata picking (DP-H46 a–e) | partial | a/b/c/d shipped (display + property-table decode, opt-in); **e (pickMetadata producer) mid-flight.** |
| CSM altitude-adaptive splits + moon dual-light | partial | `DEFAULT_LAMBDA` fixed at 0.7; altitude-driven split + moon dual-light path deferred (CSM Slices 3-4). **(by-design)** |
| PCSS / blocker-search soft shadows | partial | Contact-shadows post-effect exists; **blocker-search-region PCSS not wired.** 5-tap PCF is production path. |
| VSM / ESM shadow maps | missing | No WGSL implementation; future alternative to perspective-Z PCF. **(by-design)** |
| Linear-depth shadow cast | missing | Perspective-Z is production + cheap; linear-depth is a parked micro-optimization. **(by-design)** |
| Tile-per-cascade shadow assignment (WSM) | missing | CSM Slice 3-4 future; uniform cascade fit is current approach. **(by-design)** |

### 5.6 Post-process & Effects — 2 partial, 1 stub

| Item | Status | What's missing |
| --- | --- | --- |
| Point Cloud Eye-Dome Lighting (EDL) | **stub** | `WebGPUPointCloudEyeDomeLighting.ts` is an intentional no-op. Needs offscreen FBO + depth-writing variant + blend pass. Full WebGL exists. (C-P14) |
| f16 PP variant expansion | partial | Only Tonemapping has an f16 variant (B200); ColorGrading/FXAA/Bloom/AO/DoF/SSR/GodRays f16 + display-p3/HDR-10 canvas-configure deferred (WGF-3-EXPAND). |
| ColorGrading + FXAA on HDR scene | partial | When tonemap is skipped (HDR canvas output), ColorGrading runs on unbounded `[0..∞)` HDR → wrong saturation; FXAA SDR-tuned thresholds misfire. Needs HDR-aware math / conditional bypass. (B200-D1/D2) |

### 5.7 Entity / DataSource + Perf — 1 partial

| Item | Status | What's missing |
| --- | --- | --- |
| GeoJsonPrimitive (lightweight buffer primitive) | partial | Same as 5.2/5.4 row — renderer shipped (B315); **no WebGPU-vs-WebGL visual-regression probe** for holes + MultiPolygon. Verification-only residual. |

---

## 6. The "real fill-in queue" (genuine incomplete ports, not by-design)

Stripping out the 8 deferred-by-design `missing` items and the cross-survey-resolved
globe point-light row, **~17 items are genuine port work** that would move the
needle toward 100 %, ranked by rough effort:

1. **Voxel data path** (3D Tiles) — **XL.** The single biggest hole: full
   CustomShader→WGSL transpile + megatexture/octree traversal + per-cell pick.
   Unblocks the voxel-cell-pick stub *and* the metadata voxel-coordinate pick.
2. **Custom Shaders WGSL injection** (glTF Models) — **L.** Whole API class is a
   no-op on WebGPU.
3. **Point Cloud EDL** (Post-process) — **M.** Offscreen FBO + depth variant + blend.
4. **Clipping planes on primitives + models** (Globe/Models) — **M.** WGF-1-EXPAND.
5. **Buffer\* + Polyline + GroundPolyline 2D / Columbus-View paths** (Geometry) —
   **M.** A recurring scene-mode-morph pillar across four renderers.
6. **EXT_structural_metadata multi-component attributes + sampling audit** (3D Tiles) — **M.**
7. **Hi-Z tile-bounding-volume integration** + **ellipsoid-aware RTE** (3D Tiles) — **M/S.**
8. **DP-H46e metadata-pick producer** (Models/Picking) — **S, mid-flight.**
9. **HDR ColorGrading/FXAA math** + **f16 variant expansion** (Post-process) — **S/M.**
10. **EquirectangularPanorama cull-override** + **edge authored-silhouetteNormals**
    + **GeoJsonPrimitive verification probe** — **S each.**

---

## 7. Caveats & reconciliation notes

- **Cross-survey conflict (reconcile in inventory):** the Globe survey lists "Point/
  cube light shadows on globe terrain" as `missing` (C-R10-GLOBE-POINT-LIGHT), while
  the Picking survey lists "Globe point-light shadow receive" as `full` (resolved
  Batch 108, verified B190). The Picking survey is more specific and batch-anchored;
  treat globe point-light **receive** as functionally resolved and correct the Globe
  entry. (This report counts it as `missing` in the raw tally to match the survey as
  given, which is why the conservative number is slightly pessimistic.)
- **The 2026-06-19 `WEBGPU_PARITY_AUDIT_2026-06.md` is stale** on several P1 items:
  BufferPrimitive `color.alpha` / `blendOption` / `boundingVolume` (audit P1) and
  `EdgeDisplayMode` tri-mode (audit P2) have since SHIPPED in Batches 315/316/330.
  Use *this* report for current state.
- **Verification debt ≠ feature gap.** At least 2 partials (GeoJsonPrimitive probe,
  edge degenerate-tri confirmation) are missing *tests*, not *code*. They drag the
  strict number but a passing probe would flip them to `full` with no shader work.
- Numbers are sensitive to feature granularity (255 features chosen by the surveys).
  A coarser or finer enumeration shifts the percentage by a point or two; the
  full/partial/stub/missing **ratio** (86 / 9 / 2 / 3 % of surface) is the durable
  signal.
