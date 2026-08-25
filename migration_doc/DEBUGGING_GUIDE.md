# WebGPU Debugging Guide

**Created:** 2026-05-16 (Batch 56)
**Purpose:** Single entry point for the tools and procedures we use to diagnose CesiumJS WebGPU renderer bugs. **Start here when something is broken** — this doc points to the right tool, the right probe, and the right doc for each class of failure.

This guide is the procedures companion to:

- **[WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md)** — chronological log of what's been fixed. Search before you debug; the bug you're chasing might already be in there.
- **[FEATURE_INVENTORY.md](FEATURE_INVENTORY.md)** — what's shipped, in-flight, deferred. Cross-reference to scope a change.
- **[IMAGERY_PROJECTION.md](IMAGERY_PROJECTION.md)** — load-bearing for imagery / globe-surface bugs; read it before touching the projection chain.
- **[CLAUDE.md](../CLAUDE.md)** — rules of engagement (especially Principle 8 "probe-first").

If the answer isn't in those four, it should be in this guide. If it's not in this guide either, that's a documentation gap — add it here when you find it.

---

## Decision Tree — "I have a bug, what do I reach for?"

```text
A user reports a bug. Where do I start?
│
├── Visual artifact (wrong colors, missing tiles, mesh-pattern, halo)?
│   ├── First reach: flip an upstream debug flag (`scene.debugShow*`,
│   │   `tileset.debug*`, `globe.show*`) — often answers "is it the
│   │   imagery, the atmosphere, the LOD, or the depth buffer?" in one
│   │   line. See "Upstream Cesium debug surfaces".
│   ├── Then: CesiumDebug.globeFragmentDebug() for fragment-pipeline
│   │   bisection on the globe FS. See "Visual artifact playbook".
│   └── Then: build a probe per Principle 8.
│
├── TypeScript error / type-check failure?
│   └── See "TypeScript bugs" below. Co-located .d.ts pattern.
│
├── Pipeline / shader compilation failure (red console, "compilation
│       message", "validation error: GPURenderPipeline")?
│   └── CesiumDebug.pipelineStatus() in the browser. See "Pipeline bugs".
│
├── Perf regression (fps drop, GPU/CPU pass cost spike)?
│   ├── scene.debugShowFramesPerSecond = true for the live HUD.
│   ├── CesiumDebug.cpuPassCost(true) / .gpuPassCost(true) / .highDensityCull()
│   │   for per-pass detail.
│   └── new PerformanceTracker() for repeatable traces. See "Perf bugs".
│
├── Tile loading / streaming bug (empty tiles, never-ready imagery,
│       wrong terrain LOD)?
│   ├── First reach: add TileCoordinatesImageryProvider — does the box
│   │   show up where the tile should be?
│   ├── tileset.debugShowBoundingVolume + .debugShowGeometricError +
│   │   .debugFreezeFrame to inspect tile selection.
│   └── CesiumDebug.logImageryProbe() for tile-update tracing.
│       See "Streaming bugs".
│
├── Demo regression (Sandcastle scene that used to work)?
│   ├── First reach: node Tools/visual-regression/sandcastle-smoke.mjs —
│   │   the 3-demo WebGPU Sandcastle gate (CesiumViewer probes can ALL be
│   │   green while every Sandcastle demo is black — the DepthPlane MRT
│   │   lesson). See "Sandcastle & cross-backend".
│   └── Then: variant smoke + full Sandcastle runner. Compare to last
│       green build via git bisect.
│
├── Picking / metadata pick bug?
│   └── verify-model-feature-pick.mjs / verify-pick-webgl-control.mjs are
│       templates. Picking is one of the few places where you can't
│       probe-via-screenshot — see "Picking bugs".
│
├── Buffer-primitive (GeoJSON / vector-tile fill) looks opaque, mis-sorted,
│       wandering in 2D/CV, or never culls?
│   └── probe-geojson-primitive.mjs / probe-bufferpolygon-2dcv.mjs /
│       probe-bufferpoint-positiondatatype.mjs. Which Pass slot did the
│       command land in (OPAQUE vs TRANSLUCENT)? Is blendOption honored?
│       See "Buffer-primitive translucency / sort / 2D-CV".
│
├── glTF edges missing (EDGES_ONLY shows surfaces, no wires) or extra
│       (SURFACES_ONLY default still draws edges)?
│   └── probe-edge-emitter.mjs / probe-edge-degenerate.mjs. Confirm the
│       Pass-slot-12 (CESIUM_3D_TILE_EDGES_DIRECT) routing + SURFACES_ONLY
│       suppression. See "glTF edge tri-mode (EdgeDisplayMode)".
│
├── Need to inspect a camera, transform, or vertex attribute visually?
│   └── DebugCameraPrimitive / DebugModelMatrixPrimitive / DebugAppearance.
│       See "Standalone debug primitives".
│
├── Need an interactive UI instead of console / Playwright?
│   └── CesiumInspector / Cesium3DTilesInspector / VoxelInspector widgets.
│       See "Inspector widgets".
│
└── Bundle size / build variant regression?
    └── node Tools/variant-smoke-test.mjs + the build-size table. See
        "Build variants".
```

**All debug surfaces in this guide are accessible from Playwright** via `page.evaluate`. See "Using debug surfaces from Playwright" below for the boilerplate, common patterns, and gotchas.

---

## Visual artifact playbook (probe-first, per Principle 8)

This is the most common case and the one with the strongest workflow. **Never** ask the user to reload and confirm a visual fix when you can verify automatically.

### 1. Reproduce in a probe

- Pick the closest match from `Tools/visual-regression/probe-*.mjs` (inventory below). The probe MUST match the user's reproduction exactly: same URL query params (saved view, terrain provider, imagery provider, scene mode). Default-camera probes miss LOD-specific and view-specific artifacts.
- If no probe matches, write one. **[probe-saved-view.mjs](../Tools/visual-regression/probe-saved-view.mjs)** is the canonical template: Playwright + canvas-decode diff (no Node PNG dep), captures WebGL + WebGPU side by side and reports a per-channel pixel delta.
- Naming convention: `probe-<topic>.mjs` for diagnostic / one-shot, `verify-<feature>.mjs` for fixed scenarios that double as regression checks. Keep them small — one probe per investigation.

### 2. Capture baseline + diff

- Run the probe before changing anything. Record the mismatch %, mean delta, brightness ratio, and read the output PNGs.
- A probe that records `meanBrightnessRatio: 1.0` and `mismatchPct < 5` is parity; anything else is a real delta worth bisecting.
- Canvas readback returns all-zeros in headless mode (preserveDrawingBuffer footgun). The PNG screenshots are the source of truth; the in-page `getImageData` numbers are not.

#### Cross-backend capture pitfalls (learned the hard way, 2026-06-25)

A whole-day mis-diagnosis (`probe-confirm-inspector-sky.mjs`, sky investigation in [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md)) traced to capture-method bugs, not the renderer. Use this checklist for any WebGL-vs-WebGPU or ground-view grab:

- **A DEFERRED `canvas.toDataURL()` LIES on both backends.** On a **WebGL** canvas without `preserveDrawingBuffer` it returns a **black buffer** (post-present clear). On a **WebGPU** canvas it can come back **Y-flipped** and, at non-power-of-two canvas sizes, **diagonally skewed** (row-stride mismatch) — a black/torn triangle that looks like a render bug but is a readback bug. **Playwright element/page `screenshot()` (compositor read) is the DEFAULT for cross-backend captures.** Let the viewer's OWN render loop run + settle, then screenshot. **Corrected 2026-08-14** — this bullet used to end "not `toDataURL`" as an absolute, which conflicted with the shared capture home: a `toDataURL` **fused to its render in one page task** is the sanctioned in-page alternative, and it is `drawImage(<WebGPU canvas>)` + `getImageData` that is prohibited outright (the swap chain is invalidated after presentation, so that reader returns an empty or stale surface while the engine rendered correctly). Use `Tools/visual-regression/lib/same-task-capture.mjs` and its validators for any in-page read; see ORCHESTRATION_HANDBOOK.md §7 "Canonical capture doctrine" for the full three-way statement and the evidence behind each rule.
- **`armWebGPUDevices(page)` is REQUIRED** (from `lib/webgpu-error-gate.mjs`) for the WebGPU scene — incl. the sky atmosphere — to actually render in a probe. A quick probe that skips it renders nothing on WebGPU and your diagnostic logs never fire (you'll chase "the code path isn't reached" when really the device was never armed).
- **Apples-to-apples or it's worthless.** WebGPU-only features (`globe.showProceduralClouds`, `cloudWeatherMap`, volumetric fog, enhanced ocean) are silent no-ops on WebGL. A naive "WebGL vs WebGPU same config" diff with one of these ON compares different scenes. Add a toggle (e.g. `CLOUDS=on|off`) and confirm the variable in isolation before blaming a subsystem.
- **One-shot diag logs fire on the WRONG frame.** A `if (!global.__once)` log in a per-frame packer fires on the FIRST frame — which for a CesiumViewer app is the **default home camera (~17,000 km orbital)**, not your `setView` target. Gate it on the actual state you care about (`camera.positionCartographic.height < 5000`) so it captures the ground-view frame. Also assert capture-time camera height in the probe (`viewer.camera.positionCartographic.height`) — don't assume `setView` stuck.
- **"Is geometry even rasterizing here?" test:** put `return vec4(1,0,1,1);` (magenta) at the VERY FIRST line of the fragment shader (before any `discard`). If the region is still black, no triangle covers those pixels → it's a vertex/raster/clip/cull/projection issue, not the fragment math. Then bisect: `cullMode:"none"`, far-plane pin `output.position.z = output.position.w` (near/far clip), check `currentFrustum`/`off.near`/`proj0`/`proj5` for the actual projection. (This exact ladder ruled out everything but a still-unexplained shell-coverage gap — see the deferred BUG-WEBGPU-SKY-GROUNDVIEW-HIGH-ELEVATION-BLACK entry.)
- **A "parity gate" can be blind to the artifact.** `probe-ground-view-env.mjs` reports ground-sky parity 0.99× yet the high-elevation sky is black on WebGPU — because it samples the horizon band, not the zenith. When a gate is green but the eyes say otherwise, check WHICH pixels the gate samples.

### 3. Bisect — fragment-stage debug modes

When the artifact is in the globe fragment shader pipeline (imagery composite, ground atmosphere, fog, HSB), use `CesiumDebug.globeFragmentDebug(name)` to short-circuit `fragmentMain` and visualize one intermediate. Registry: **[WebGPUGlobeFragmentDebug.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts)**.

| Mode | What it shows | When to reach for it |
| --- | --- | --- |
| `uv` | `(geoU, geoV, webMercatorT, 1)` | Vertex stage producing wrong UVs |
| `alpha` | Layer 0 `texCoordsAlpha` mask | Tile-edge transparency artifacts |
| `layer-count` | `(count/16, layer0 mask, layer1 mask)` | Tile straddle / multi-imagery layering |
| `sample0` / `sample1` | Raw `sampleImagery(dayTextureN).rgb` | Texture content / upload-format issues |
| `tex0-alpha` / `tex1-alpha` | Per-layer `texSample.a` as grayscale | Reprojection-target alpha problems |
| `post-composite-color` | Imagery color BEFORE material / atmo / fog | Isolates "imagery composite vs downstream effects" |
| `post-composite-alpha` | Composite alpha accumulator | Same, for alpha channel |
| `fade-amount` | Ground-atmosphere `fadeAmount` | "Is drape overwriting imagery?" |
| `draped` | Tonemapped drape color | Drape formula problems |
| `atmo-color` | `groundAtmoColor` per-fragment | Per-fragment scattering correctness |
| `transmittance` | Drape transmittance | Atmosphere optical-depth issues |
| `rayleigh-v` / `mie-v` | Per-vertex `v_atmosphere*` varyings | Vertex-stage atmosphere ray-march |
| `view-dir` | `normalize(positionWC - cameraWC) * 0.5 + 0.5` | RTE camera reconstruction sanity |
| `mip4` | Explicit `textureSampleLevel(LOD=4)` of layer 0 | Verify mipmap chain exists |
| `lod-magnitude` | Sampler LOD as grayscale | Verify per-fragment derivatives drive mip selection |
| `force-red` | `vec4(1,0,0,1)` end-of-fragment | Discriminate FS dimming vs canvas/display dimming |
| `water-effect-trigger` | Red = water + reflective-ocean on, yellow = water mask but land, green = no reflective ocean | Verify `tile.flags.x` (Batch 58 fix) |
| `bypass-none` | Full shading, no term skipped (control run; wave clock frozen at 0 like every `bypass-*` mode) | Baseline for A/B term attribution |
| `bypass-underground` | Full shading MINUS the underground tint blend | Attribute the below-surface residual (B2 decomp) |
| `bypass-translucency` | Full shading MINUS the per-fragment translucency alpha ramp | Same |
| `bypass-drape` | Full shading MINUS the far-from-ground ground-atmosphere drape mix | Same |
| `bypass-seam-clamp` | Raw (unclamped) fragment-entry UVs — reverts the B506 seam clamp | Same |
| `bypass-glint` | Full shading MINUS the B506 Phong ocean sun-glint | Same |
| `bypass-fog` | Full shading MINUS the near-ground fog mix | Same |

Call `CesiumDebug.globeFragmentDebug()` with no args to get the live list from the registry.

**`bypass-*` modes (NEW-GLOBE-BELOWSURFACE-DECOMP, sentinels 21e9–27e9)** differ from the visualization modes above: they do NOT short-circuit `fragmentMain`. The full shading path runs with exactly ONE term skipped, so `diag-globe-belowsurface-decomp.mjs` can diff each bypass against `bypass-none` (same page, same tile state) and attribute the WebGL↔WebGPU signed-dRGB residual per term. Production is untouched — the sentinel writer is pragma-stripped and real `tile.time` < 1e6 keeps every bypass predicate false.

**Adding a new mode:** append an entry to `GLOBE_FRAGMENT_DEBUG_MODES`, add the matching `if (tile.time > N - 0.5e9 && tile.time < N + 0.5e9)` branch in [GlobeTerrain.wgsl::fragmentMain](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl), rebuild. Sentinels are 1e9 apart so the WGSL guards stay unambiguous.

### 4. Verify the fix

- Re-run the same probe. A fix that doesn't move the diff is not a fix.
- Look at the PNGs yourself, don't trust just the diff number.
- Check that the fix didn't introduce a *new* artifact somewhere (caribbean-mid, close-zoom, polar). Run at least one orbit + one close-zoom probe before claiming done.
- Document in **[WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md)** with file paths, root cause, and the probe that proves it.

### 5. Anti-patterns

- "Try reloading and let me know" — you have a probe for that. Use it.
- "The build has the fix so it should work" — grep proves bytes are present, not that the runtime path is reached.
- "Default-camera probe was clean" — when the user reported a specific view, match it. LOD and atmosphere ramps are camera-distance-dependent.
- "I'll just add three speculative fixes and rerun" — probe-first costs less per iteration than speculative-fix-first.

---

## Buffer-primitive translucency / sort / 2D-CV

Buffer primitives are the shared substrate behind `GeoJsonPrimitive`, the modern glTF-vector (`CESIUM_mesh_vector`) 3D Tiles fill, and the entity bulk / compute-instance WebGL2 cpuKernel paths. They render through three FeatureRenderers — `WebGPUBufferPointRenderer.ts`, `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts` (shared base `WebGPUBufferPrimitiveRenderer.ts`). The common WebGPU divergences from WebGL all live in pass/pipeline selection and the packed color lane.

### Symptom → check

- **Fill is fully opaque even at `color.alpha < 1`** — the renderers historically truncate color to RGB (`csm_decodeRGB8`, alpha hardcoded 1.0) so the WGSL `if (outColor.a < 0.005) discard` is dead. If alpha doesn't vary, the packed lane was never widened to carry it. The CPU pack width, the GPU `arrayStride`/`format`, and the WGSL struct field must move in lockstep — a stride mismatch is silent corruption, not a compile error.
- **Stacked/adjacent opaque polygons show sort artifacts** — the command was pushed to `Pass.TRANSLUCENT` with `depthWriteEnabled=false` regardless of `collection._blendOption`. **Which Pass slot did the command land in?** OPAQUE collections must route to `Pass.OPAQUE` (blend off, depth-write on); a collection that defaults TRANSLUCENT (GeoJSON fills do) but is logically opaque will be order-dependently composited. Compare against WebGL's branch in `renderBufferPointCollection.js` / `renderBufferPolygonCollection.js`. Probe: `probe-geojson-primitive.mjs` (drives the full alpha / blendOption / boundingVolume chain through the loader).
- **Every collection draws every frame / `debugShowBoundingVolume` is a no-op** — the buffer draw commands are built without `boundingVolume` / `debugShowBoundingVolume` (`WebGPUDrawCommand` supports both). No bounding volume = no per-frustum culling. The Scene-side `_boundingVolume` is world-space and auto-updates, so it must be refreshed onto the command **every frame**, not once at creation.
- **Markers wander or vanish in SCENE2D / Columbus View** — the buffer renderers project RTE world-space ECEF via `modelViewRelativeToEye * projection` with NO 2D/CV reprojected attribute buffer (unlike the Vector3DTile classifiers' CPU-reprojected ENU buffer). SCENE3D is verified (Batch 180); 2D/CV is the open gap. Probe: `probe-buffer-2dcv-parity.mjs` (historical predecessor: `probe-bufferpolygon-2dcv.mjs`). (Distinct from `NEW-CLASSIFIER-2D-CV-MORPH`, which is the `.vctr` classifier family.)
- **A non-DOUBLE / `positionNormalized` collection renders garbage positions** — all three renderers assume DOUBLE positions (always `float32x3` high/low RTE); an integer/normalized `positionDatatype` store is read as f64 cartesians. Probe: `probe-buffer-integer-position.mjs` (historical predecessor: `probe-bufferpoint-positiondatatype.mjs`).

Authoritative gap list + first-step plans: **[WEBGPU_PARITY_AUDIT_2026-06.md](WEBGPU_PARITY_AUDIT_2026-06.md)** (the buffer-primitive P1/P2 rows).

## glTF edge tri-mode (EdgeDisplayMode)

`EdgeDisplayMode` on glTF Models + 3D Tilesets has three modes — `SURFACES_ONLY` (default, 0), `SURFACES_AND_EDGES` (1), `EDGES_ONLY` (CAD wireframe, 2) — driven by the `EXT_mesh_primitive_edge_visibility` data path. The WebGPU emitter is `WebGPUEdgeVisibilityEmitter.ts`; dispatch + pass routing is in `WebGPUModelRenderer.js` / `WebGPUSceneRenderer3DTilePasses.ts` / `WebGPUSceneRendererFrustumLoop.ts`.

### Symptom → check

- **`SURFACES_ONLY` (the default) still draws edges** — the edge emitter gates only on `defined(edgeGltfPrimitive?.edgeVisibility)` and never reads `model.edgeDisplayMode`, so any edge-bearing glTF emits edges even in the default mode. **To confirm SURFACES_ONLY suppression:** verify the emitter early-returns when `model.edgeDisplayMode === EdgeDisplayMode.SURFACES_ONLY` (a one-line guard) — if edges appear in the default mode on an edge-bearing CAD/BIM asset, the guard is missing.
- **`EDGES_ONLY` renders surfaces normally with NO edges (the inverse of intent)** — three coupled gaps: (1) the `Pass.CESIUM_3D_TILE_EDGES_DIRECT` slot (**slot 12** in `Renderer/Pass.js`) is absent from the WebGPU frustum loop, so commands binned there **silently never execute**; (2) the WebGPU model edge emitter hardcodes `Pass.CESIUM_3D_TILE_EDGES` (slot 4) instead of routing to slot 12 for EDGES_ONLY; (3) the surface command is emitted unconditionally with no EDGES_ONLY suppression. **Which Pass slot did the edge command land in?** Slot 4 (`CESIUM_3D_TILE_EDGES`) is the with-surfaces edge pass; slot 12 (`CESIUM_3D_TILE_EDGES_DIRECT`) is the EDGES_ONLY direct pass that must actually be looped over in `WebGPUSceneRendererFrustumLoop.ts`. A command in slot 12 that produces no pixels means the frustum loop has no slot-12 leg.
- **Edges vanish near a zero-area triangle / silhouette mis-classified** — RESOLVED (EDGE-AUTHORED-SILHOUETTE-NORMALS, 2026-07-02): when the mesh authors `silhouetteNormals`, WebGPU now consumes the accessor (WebGL-identical decode + sequential pair indexing); only accessor-less (out-of-spec) meshes fall back to synthesized face normals, where the magnitude guard + bounds skip still prevent NaN. Probes: `probe-edge-authored-silhouette.mjs` (authored path + off-gate), `probe-edge-degenerate.mjs` (PR#13421 repro, derived fallback); general edge emission: `probe-edge-emitter.mjs`.
- **A BENTLEY / styled-gltf-lines asset yields zero WebGPU edges** — RESOLVED: the extractor now consumes all the extension's encodings — the per-triangle 2-bit `edgeVis.visibility`, explicit `lineStrings` edges (Batch 316), per-edge `materialColor` overrides (Batch 330), and authored `silhouetteNormals` (EDGE-AUTHORED-SILHOUETTE-NORMALS, 2026-07-02). If a styled asset still yields zero edges, check `model.edgeDisplayMode` (SURFACES_ONLY, the default, suppresses all extension edges).

Authoritative gap list + first-step plans: **[WEBGPU_PARITY_AUDIT_2026-06.md](WEBGPU_PARITY_AUDIT_2026-06.md)** (the EdgeDisplayMode P2/P3 rows).

---

## CesiumDebug — browser DevTools console commands

Installed by [Apps/CesiumViewer/CesiumViewer.js](../Apps/CesiumViewer/CesiumViewer.js) on viewer init. Source: **[packages/engine/Source/Scene/CesiumDebug.js](../packages/engine/Source/Scene/CesiumDebug.js)** (always the source of truth — if this table drifts, the file wins).

| Command | Purpose | WebGL? | WebGPU? |
| --- | --- | :---: | :---: |
| `help()` | List all commands | ✓ | ✓ |
| `snapshot()` | Full scene + renderer + toggles dump | ✓ | ✓ |
| `showDepth()` / `hideDepth()` | Depth buffer as grayscale (log-normalized over full near/far) | ✓ | ✓ |
| `showDepthWindow(minM, maxM, turbo)` | **Windowed Turbo color depth** — full color range on eye-z band `[minM,maxM]` m; discriminates near-identical depths the plain view collapses. Needs `scene.msaaSamples=1`. NOTE: samples the FINAL (depth-test winner) depth — can't show a primitive that LOST the test | — | ✓ |
| `skipDepthPlane(on)` | Skip the ellipsoid depth-plane render (debug bisect, both backends) | ✓ | ✓ |
| `showWireframe()` / `hideWireframe()` | Globe wireframe overlay | ✓ | ✓ |
| `showFrustums()` / `hideFrustums()` | Colorize frustum splits | ✓ | ✓ |
| `showCommands()` / `hideCommands()` | Command-count overlay | ✓ | ✓ |
| `toggleFPS()` | FPS counter | ✓ | ✓ |
| `pipelineStatus()` | Shader / pipeline / device-loss / FB health table | partial | ✓ |
| `postProcess()` | Post-process pipeline state table | partial | ✓ |
| `cpuPassCost(true \| false \| undefined)` | CPU per-pass profile (R-7a) | — | ✓ |
| `gpuPassCost(true/false)` | Enable+reset / disable GPU per-pass timing; no arg dumps samples (timestamp-query) | — | ✓ |
| `highDensityCull()` | GPU culler / HiZ / sort-keys stats (Batch 217) | — | ✓ |
| `hiZConsume(on)` | FORK-41 diagnostic toggle for whether Hi-Z results may drop occluded commands. FAR-003 currently contains GPU culling/Hi-Z/sort/indirect selection as opt-in, so the stable default does not build, dispatch, or read back this path. Use only with an explicit characterization mode until safe automatic selection is restored. | — | ✓ |
| `webgpuOIT(on?)` | Reads/toggles the FAR-003 MRT-OIT containment flag (default-off ratified 2026-07-16; translucency falls back to sorted alpha); logs requested-vs-active state. No arg = read current state. | — | ✓ |
| `attachmentDemand(force?)` | C9-09 — dumps the canonical per-frame scene-FB attachment-demand record (`getDebugSnapshot().attachmentDemand`: G-buffer readers, `topology`, `gbufferDemanded`) alongside the ACTUAL measured topology (color-attachment count, G-buffer bytes, slot-1 opens/resolves) plus `recordMatchesActual` (Batch 684 folds the measured slot-1 open counter into that match so it is no longer tautological). `attachmentDemand(true)` forces full MRT (today's default); `attachmentDemand(false)` is **BLOCKED (refused, no-op with a permanent warn)** until C9-10 lands the 31-renderer topology-keyed cache audit — a live mid-session MRT flip is unsafe before then. Observe-only in C9-09 — nothing gates on the record yet. | — | ✓ |
| `globeBindGroups()` | Globe bind-group cache stats (Batch 241) — healthy steady-state: `lastFrameCreates` ~0, high `hitRate` | — | ✓ |
| `cacheStats()` | C11-174 — `console.table` of the central render-pipeline cache + post-process bind-group cache counters (hits/misses/hitRate/size/evictions) from `getRendererStatistics()`. Pure exposure of counters the caches already maintain — no new per-frame work. Near-zero bind-group `hitRate` = Batch-717 churn shape (resource identities recreated every frame). | — | ✓ |
| `cloudStats(t/f)` | **C13-02 — cloud CPU/GPU observability and temporal-cost counters.** `console.table` of the raymarch lane (target size, pixels dispatched, resolved `maxSteps`/`lightSteps`, half-res flag), the reconstruction lane (history resolve size + pixels, this frame's accept/reject/reset verdict and its reason bitmask, plus the lifetime generation/reset/accepted totals), the shadow lane (pass count, single-map edge, cascade atlas tile size x count), the weather texture cache (hits / misses / uploads / upload bytes / live bytes) and the per-frame pass ledger. Every counter is bookkeeping the cloud renderer already pays for on its encode path — calling this adds no per-frame work. **The optional boolean toggles CPU STAGE TIMING** (`total`/`pack`/`shadow`/`temporal`/`composite`), which is OFF by default because a `performance.now()` pair straddling each stage is observable work on the shipped path and C13-02 requires the instrumentation to be removable without changing the render result; toggling CLEARS the accumulated window so a stale run cannot read as current. **The `gpu` block is the UNION of the seven cloud passes' GPU intervals, not their sum** — folded through the same `summarizeFrameCoverage` as C11-140's whole-frame ledger, so `cloudOverlapMs > 0` is a real finding (two cloud passes overlapped and a naive sum would double-count that span) and the command warns on it. `gpu` is `null` rather than zero-filled when the adapter has no `timestamp-query` or no readback has landed, because a zeroed timing block is indistinguishable from a genuinely idle lane. The environment `DynEnvMap Sky Fill` is reported as its OWN scope, never folded into the cloud union. | — | ✓ |
| `cloudReconstructionAttachments(t/f)` | **C13-09 — the cloud RECONSTRUCTION ATTACHMENT set (front / transmittance-weighted depth, screen-space velocity with an explicit validity channel, depth+coverage moments).** Reads, or with a boolean toggles, the opt-in producer. Prints the per-slot CONTRACT (slot, key, format, bytes/texel, owned-here, producer, consumers, channel semantics) and then this frame's state: produced, target size, pixels dispatched, target count, generation, resident bytes. **DEFAULT OFF, and that is the shipped contract** — with it off nothing is allocated and no pass is encoded, so the cloud lane is identical in pixels AND in cost. **With it ON the composite is STILL byte-identical**, because NOTHING READS THE SET: the consumers are C13-10 (true 1/16-rate current-frame march) and C13-12 (motion/depth rejection, variance clipping, reactive history, wind-aware reprojection, disocclusion), and the `consumers` column reading empty is the honest state rather than a formatting artifact. That is what makes it safe to leave enabled while measuring. The producer needs the HALF-RES march target and a perspective, non-morphing frame, so a cinematic tier (`renderResScale === 1`) or the `cloudQuality !== 64` escape hatch produces nothing even when enabled — set `cloudVolumetricQuality` to "low" or "medium" to exercise it, and the command says so when it sees enabled-but-not-produced. The generation is monotonic across resize and device swap and is never rewound on release, so a bind group captured under an earlier generation can be recognised as stale (the key C13-40's retirement work needs). | — | ✓ |
| `cloudReconstruction(t/f)` | **C13-10 — march-emitted reconstruction depth + its first consumer.** A SECOND switch on top of `cloudReconstructionAttachments`, and the separation is the point: with only the attachments on, the set is produced and read by nobody (C13-09's state, which keeps its byte-identical acceptance leg meaningful). With THIS on, the half-res march compiles the `CLOUD_MARCH_EMIT_RECONSTRUCTION` variant and writes the depth slot from its own per-sample accumulation, the producer reads that target instead of estimating (`producerTargets` 3 → 2 — the counter that proves ownership MOVED rather than the slot being written twice), and the temporal resolve validates history against the set — so **the composite MAY differ**, the first row for which that is true. Enabling implies the attachment set; disabling leaves the set allocated so the two states can be A/B'd without a reallocation between legs. Counters under `reconstruction.emission` (`requested` is resident — a frame that asked and fell back must not read as "nobody asked"). WebGPU-only; needs the half-res tier, like the attachments command. | — | ✓ |
| `pick(reset?)` | **Pick-readback instrument (picking stage S0 — Batch 1075, `d4fa0ecf48`).** Dumps `WebGPUPickFramebuffer.getStatistics()`: every readback region is stamped with the pick clock, `endCalls === servedFresh + servedCached + cold` is the ledger identity, declines are counted per reason, and a bounded `recentDeclines` ring records why each recent pick could not be answered — so "scene.pick returns undefined" is distinguishable from a real miss at the console. `pick(true)` zeros the counters, then dumps. Instrument-first by design: change no pick gate without this measurement — see [PICKING_ARCHITECTURE_STATE_2026-08-17.md](PICKING_ARCHITECTURE_STATE_2026-08-17.md). | — | ✓ |
| `canvasPixels()` | Sample canvas pixel data | ✓ | ✓ |
| `logImageryProbe()` | Dump next 4 tile updates to console | ✓ | ✓ |
| `globeFragmentDebug(name)` | Short-circuit globe FS to visualize one stage | — | ✓ |
| `globeFragmentDebug()` | List all available modes | — | ✓ |
| `scene` / `context` / `device` | Direct accessors for live debugging | ✓ | ✓ |

### Common diagnostic sequences

**Pipeline failure** (red console at viewer init):

```javascript
CesiumDebug.pipelineStatus();      // is the device lost? render pass open? FB attached?
CesiumDebug.snapshot();            // full state dump for the bug report
```

**Globe renders wrong** (artifact you can see):

```javascript
CesiumDebug.globeFragmentDebug();                       // list modes
CesiumDebug.globeFragmentDebug("post-composite-color"); // narrow imagery vs effects
CesiumDebug.globeFragmentDebug("atmo-color");           // narrow atmosphere
CesiumDebug.globeFragmentDebug(null);                   // restore production
```

**Perf regression at orbit**:

```javascript
CesiumDebug.cpuPassCost(true);     // start sampling
// ... let scene run 5 seconds ...
CesiumDebug.cpuPassCost();         // dump rolling-window stats
CesiumDebug.gpuPassCost(true);     // enable + reset (needs timestamp-query)
CesiumDebug.gpuPassCost();         // dump resolved GPU samples
CesiumDebug.highDensityCull();     // is the GPU culler pulling its weight?
CesiumDebug.cpuPassCost(false);    // stop sampling
```

**Tile loading bug**:

```javascript
CesiumDebug.logImageryProbe();     // dumps next 4 tile updates to console
// inspect: did the tile reach READY? what's its readyImagery vs loadingImagery?
```

---

## Probe inventory (`Tools/visual-regression/`)

**Two views, one fleet.** This inventory is the *curated* view — the first probe to run for a given subsystem question, plus the capture templates and the standing gates. It is deliberately small and hand-maintained. The *everything* view is **[TOOLING_CATALOG.md](TOOLING_CATALOG.md)**: a generated census of all 1,012 `.mjs` files under `Tools/` and `scripts/`, each with its class (probe / spec / gate-lib / lib / runner / bake-tool / fixture / scratch) and its status (`ACTIVE`, `INVESTIGATION_ARTIFACT`, `LIKELY_SUPERSEDED`, `BROKEN_STALE`, `HELD_FOR_D8`, `DELIBERATE_RED_FLAG`, `UNKNOWN`). Use this guide for "what do I run first"; use the catalog for "does an instrument for X already exist" and "is the file I just found still in service". The split is deliberate — the catalog absorbs per-batch churn so this guide's must-stay-synced rule stays honorable.

**The count is CENSUS-DERIVED, not typed by hand** *(corrected 2026-08-09, handover audit FIX 36 — this line read "260+" against a disk reality more than twice that, which invited a successor to conclude the fleet was small enough to read).* Re-derive it, never copy it:

```bash
ls Tools/visual-regression/probe-*.mjs | wc -l          # 624 at tip 161d99950b
node --test Tools/visual-regression/probe-fleet-contract.spec.mjs
```

`probe-fleet-contract.spec.mjs` is the fleet's structural authority — it enumerates every probe and enforces the fleet-wide rules (verdict-vs-exit-code agreement, watchdog presence, no allowlisting of structural rules). **If you want to know what the fleet contains or whether a rule holds across it, run that spec; do not trust a prose count anywhere in this guide.**

The curated table below is **not exhaustive** — many probes are finer-grained bisection variants of the documented gates. Use it to find an existing probe before writing a new one; most "I need to test X" cases have a template.

**The everything-view lives elsewhere, and it is generated.** This guide is the curated "first probe to run per subsystem" view; the full census of every `.mjs` under `Tools/` and `scripts/` is [TOOLING_CATALOG.md](TOOLING_CATALOG.md), regenerated from each file's own `@purpose` / `@status` header by `node Tools/generate-tooling-catalog-launcher.cjs` (maintainer ruling M2; the launcher executes the tracked/staged generator - direct generator invocation is refused). Two consequences for anyone adding a probe: (1) give it a `@purpose` one-liner and a `@status` — `node --test Tools/visual-regression/purpose-header-contract.spec.mjs` enforces it, and the header is the only manual documentation step there is; (2) when the probe's question is answered, retire it by the ritual in [EXECUTOR_LANE_CHARTER_2026-08-14.md](EXECUTOR_LANE_CHARTER_2026-08-14.md) §3.6 — bank the conclusion in `WEBGPU_DEBUGGING_LOG.md`, then promote or archive. Leaving it in place is the third state that produced this guide's four ghost entries.

> **PROBE_BASE gotcha:** most probes default to `http://localhost:8080`, but `probe-collections-regression.mjs` and `probe-pick-basic.mjs` default `PROBE_BASE` to `:8134`. Against the standard dev server, run them with `PROBE_BASE=http://localhost:8080` or they fail on connection, not on rendering (this bit the 2026-07-03 campaign audit sweep — both pass at `:8080`).

### The spec fleet — the durable-contract layer

Probes are instruments; the `*.spec.mjs` fleet is the **contract** layer, and it is where a finding goes to become permanent. Specs run under Node's own test runner, one file at a time:

```bash
node --test Tools/visual-regression/<name>.spec.mjs
```

They are **browser-free unless the file says otherwise** — a spec asserts over pure functions, gate libraries, manifests and recorded artifacts, so it needs no dev server, no Edge and no GPU. That is also why the retirement ritual for an investigation probe is "bank the conclusion, then promote or archive": a probe proves something once, a spec keeps proving it. The census counts ~172 specs; this guide names only the ones you are likely to run by hand.

**Exit codes are frozen fleet-wide, not per-probe convention.** Probes and gate libraries resolve their verdict through [lib/verdict-exit-gate.mjs](../Tools/visual-regression/lib/verdict-exit-gate.mjs), whose table is the single authority:

| Exit | Verdict | Meaning |
| --- | --- | --- |
| `0` | `PASS` | The lane saw its subject and the subject met the bar. |
| `1` | `FAIL` | The lane saw its subject and the subject missed the bar. |
| `2` | `ERROR` | The harness broke — exception, timeout, wedged page. |
| `3` | `STRUCTURAL` | The lane could not see its subject at all, so it has no standing to report either a pass or a fail. |

Read exit 3 as "this run proves nothing", never as a soft fail — that distinction is why the table was centralized at all (six sibling copies, five agreeing; the sixth routed `STRUCTURAL` to `2` and made a blind lane indistinguishable from a crashed one). `probe-fleet-contract.spec.mjs` enforces verdict-vs-exit-code agreement across the fleet.

### Templates / starting points

| Probe | What it does |
| --- | --- |
| [probe-saved-view.mjs](../Tools/visual-regression/probe-saved-view.mjs) | **Canonical template.** Playwright + canvas-decode diff for WebGL vs WebGPU at a specific saved view. Copy this when starting a new visual investigation. |
| [capture-and-diff.mjs](../Tools/visual-regression/capture-and-diff.mjs) | Three-axis multi-scene regression suite (`scenes.json`): current WebGL vs reviewed historical WebGL, current WebGPU vs reviewed historical WebGPU, and current cross-backend parity, plus the WebGPU error/device-loss gate. Missing or unreviewed provenance is explicitly `NON_CERTIFYING`; promotion requires confirmation, rationale, reviewer, a green parity/error run, and a follow-up normal run. See [Tools/visual-regression/README.md](../Tools/visual-regression/README.md). |
| [lib/webgpu-error-gate.mjs](../Tools/lib/webgpu-error-gate.mjs) | **Shared WebGPU error/crash gate** (Batch 207). Catches uncaptured validation errors (`device.onuncapturederror`) + device-loss (`device.lost`) + WebGPU-fault console prints, so a harness FAILS on the FORK-34 class (engine spews GPU errors but the page limps on). Wired into `variant-smoke-test.mjs` + `capture-and-diff.mjs`; import `errorGateInit` / `armWebGPUDevices` / `collectGateErrors` / `attachConsoleErrorGate` into any new Playwright harness. Self-tested by `probe-error-gate-selftest.mjs`. |
| [probe-debug-api.mjs](../Tools/visual-regression/probe-debug-api.mjs) | End-to-end test of `CesiumDebug.globeFragmentDebug()`. Template for testing new CesiumDebug commands. |
| [probe-attachment-demand-registry.mjs](../Tools/visual-regression/probe-attachment-demand-registry.mjs) | C9-09 acceptance — asserts `getDebugSnapshot().attachmentDemand` (the canonical per-frame attachment-demand record) matches the ACTUAL scene-FB topology (2 color attachments, G-buffer bytes, slot-1 opens/resolves) on the default scene and with each G-buffer consumer (deferredLighting/SSR/NPR/contactShadows/debugOverlay/SSGI) enabled independently. Observe-only; `forceSceneMRT` stays true so topology never leaves MRT. Companion pure-function spec: `attachment-demand-registry.spec.mjs` (`node --test`). |
| [probe-brightness-ratio.mjs](../Tools/visual-regression/probe-brightness-ratio.mjs) | Measures WebGL/WebGPU per-globe-pixel mean-RGB ratio across 5 camera distances. Writes `output/brightness-ratio-report.json` for trend tracking. Template for any "is backend X darker than backend Y?" measurement. **Critical:** compute per-globe-pixel (not full region) — globe-size differences in the screenshot will bias full-region averages. |
| [probe-brightness-no-atmo.mjs](../Tools/visual-regression/probe-brightness-no-atmo.mjs) | Brightness ratio variant with `globe.showGroundAtmosphere = false`. Isolates the imagery-composite path from the drape branch — if the gap persists here, the bug is in composite (Batch 58) or earlier. |
| [probe-brightness-bisect.mjs](../Tools/visual-regression/probe-brightness-bisect.mjs) | Compares `final` vs `post-composite-color` vs `sample0` vs `sample1` at multiple camera altitudes. Surfaces whether dimming happens at the texture sample, the composite chain, or downstream effects. |

### Globe / imagery / projection

| Probe | What it covers |
| --- | --- |
| `probe-globe-underground.mjs` | **GLOBE-UNDERGROUND-COLOR acceptance + regression gate (2026-07-02).** Camera 30 km below the surface: (a) red `globe.undergroundColor` + custom `undergroundColorAlphaByDistance` ramp vs WebGL, (b) upstream-default underground look, (c) above-ground default off-gate. Judged relative to the above-default standing residual (imagery-LOD/atmosphere, ~22%). Guards the underground tint AND the Bug 487 fixes (no-cull pipeline-name aliasing, fog-off-underground, skirt suppression). |
| `probe-globe-polar-stretch.mjs` | **GLOBE-POLAR-STRETCH acceptance + regression gate (2026-07-02, extended by GLOBE-POLAR-STRETCH-POLISH 2026-07-03).** Three zooms (mid 2 Mm / far 25 Mm / extreme 55 Mm), WebGL vs WebGPU, default viewer. Disc-normalized latitude-band metrics (ice/Greenland centroid Y, top-half land-profile shift, ice area ratio) + tightened mismatch ceilings (mid 0.27% / far 3.5% / extreme 4.5%) + a **bucket decomposition** of the residual (space stars / limb ring / interior thin AA / interior blobs split by brighter backend) with a dark-navy tile-seam fingerprint gate (BUG-GLOBE-TILE-SEAM-LINES must stay ≈ 0 — guards the fragment-entry UV clamp in `GlobeTerrain.wgsl`). Also guards the `ReprojectWebMercator.wgsl` orientation fix (far-zoom latitude-mirror warp) and the `czm_getSpecular` ocean-glint port. Run after ANY change to the reprojection chain, imagery texture variant selection, imagery samplers, or the globe ocean/specular path. Writes per-view bucket-mask PNGs + report.json to `output/globe-polar-stretch/`. |
| `probe-globe-translucency.mjs` | **`globe.translucency` front/back alpha gate (GLOBE-TRANSLUCENCY-ALPHA, Batch 488), webgl-vs-webgpu.** Three legs: front-face-only translucency (alpha 0.5), a `frontFaceAlphaByDistance` ramp, and the default-off off-gate (camera-UB translucency tail all-zero + `control.x=0` keeps the FS on the historical path — byte-identical default rendering). Guards the GlobeFS→GlobeTerrain.wgsl `interpolateByDistance` alpha port, the ALPHA-blend/depth-write-off front-face pipeline selection + `_DOF` depth-only pre-pass (WebGL `getDerivedCommandTypes` pass-structure parity), and the `SkyAtmosphere.wgsl` GLOBE_TRANSLUCENT port gated on `atmosControl.w` (without it the WGSL sky floods the see-through planet disk with daylight blue — the fix that took terrain diff 99.8%→22.9%). **RESOLVED as of the M-OIT re-verify (2026-07-18): all 3 legs PASS — off-default 0.50%, translucent-space 3.35%, translucent-terrain 0.46%.** The former **standing FAIL (2026-07-03 audit): translucent-terrain 25.49% vs a 10.5% dynamic limit** — the campaign's default-view polish tightened the shared baseline (~15%→2.5%) onto a below-surface/atmosphere darkening residual that measured 22.9% at B488's own landing (WebGPU uniformly darker, dRGB −5.9..−6.7) — is no longer reproduced (Campaign-9 darkening/atmosphere fixes closed it). Tracked with `probe-globe-underground`'s twin numbers; do NOT loosen the limits. Run after touching the translucency camera/tile-UB tails, the derived-pipeline selection, or the SkyAtmosphere translucent gate. |
| `probe-oit-transparency.mjs` | **OIT coverage + WebGPU-OIT default-flip evidence (M-OIT-COVERAGE-AND-FLIP-EVIDENCE, Batch 700), webgl-vs-webgpu.** Scene of 3 mutually-intersecting translucent ellipsoids (α0.5, R/G/B) + a translucent polygon — the case where per-object sorted alpha is provably wrong at the interpenetration lines and OIT differs. Oracles: (a) WebGL `orderIndependentTranslucency` on vs off differ **9.80%** at intersections ⇒ WebGL OIT genuinely active [HARD GATE]; (b) WebGPU default vs WebGL-off **0.69%** (sorted≈sorted, recorded); (c) `CesiumDebug.webgpuOIT(true)` → gate flips (requested/capable/safetyGate true) + 0 device/validation errors + non-black, but **active=FALSE** (fallback `inactive-or-resources-not-ready`), parity vs WebGL-OIT-on **10.33%** (WebGPU stays at the OIT-*off* look) [HARD GATE on the flip mechanics; active=FALSE is the recorded FINDING]; (c-splat) synthetic splat + `_webgpuOITEnabled`+`_splatOITDeferral` armed → `_webgpuOITActiveThisFrame` never true (0 errors); (d) `webgpuOIT(false)` restores within the dither noise floor (control-measured) [HARD GATE]; (e) the 4-probe standard-transparency net is run SEPARATELY (printed by the probe) — nesting Edge launches is a machine-safety hazard. **Finding it proves:** the WebGPU MRT-OIT accumulation path is unreachable for standard translucency — only Gaussian splats + the opaque globe produce `_shaderCode`, and neither lands in `Pass.TRANSLUCENT`, so `hasOITPipelines` is always false and the Batch-697 `_ensureSceneColorResolved` composite line never executes. Recreates the viewer per backend (controls the OIT constructor option); filters benign `reason=destroyed` teardown console lines. Writes `output/oit-*.png` + `oit-transparency-report.json`. Run after any change to `WebGPUOIT.ts`, `WebGPUSceneRendererTranslucentPass.ts`, the `_webgpuOITEnabled`/`_splatOITDeferral` gates, or `CesiumDebug.webgpuOIT`. See `migration_doc/OIT_DEFAULT_FLIP_EVIDENCE_2026-07-18.md`. **UPDATED C11-157 Slice A (2026-07-18):** now runs at `msaaSamples=1` and oracle (c) is a HARD GATE on `active=TRUE` — translucent PRIMITIVES now REACH the accumulation path (parity vs WebGL-OIT-on collapsed to **1.33%**, was 10.33%). A false `active` is now a Slice-A regression, not the historical finding. |
| `probe-oit-primitive-reachable.mjs` | **C11-157 Slice A — translucent PRIMITIVES now reach WebGPU MRT-OIT (WebGPU-only, gate-flip).** Two scenes at `msaaSamples=1`: `lit` (canonical 3 intersecting translucent ellipsoids + polygon via `PerInstanceColorAppearance` flat:false → LIT `PrimitivePhongColor` → OIT via the `injectOITOutput` STRUCT branch) and `flat` (`PerInstanceColorAppearance({flat:true})` ellipsoids → `PrimitiveBasicColor` → OIT via the legacy single-`@location` path). Per scene: capture gate-OFF (sorted alpha), flip `CesiumDebug.webgpuOIT(true)`, render, capture gate-ON, restore. HARD GATES: `_webgpuOITActiveThisFrame`=TRUE (was ALWAYS false), 0 device/validation errors, gate-ON non-black, gate-ON visibly differs from gate-OFF (non-degenerate WBOIT), restore ≈ noise floor. The `SCENE` env (`lit` or `flat`) selects one scene (default both) — one scene per Edge session is the machine-safe way to run it (3-min watchdog). `grabCanvas` renders 3 fresh frames before each screenshot (WebGPU canvas has no preserveDrawingBuffer). Writes `output/oitprim-*.png` + `oitprim-report.json`. Run after any change to `WebGPUOIT.injectOITOutput`, the primitive OIT wiring in `WebGPUPrimitiveCommands.ts`, or `WebGPUSceneRendererTranslucentPass.ts`. |
| `probe-oit-collection-reachable.mjs` | **C11-157 Slice B — translucent COLLECTIONS now reach WebGPU MRT-OIT (WebGPU-only, gate-flip).** Same shape as the primitive probe but for the COLLECTION family, three scenes at `msaaSamples=1`: `point` (3 overlapping α0.5 PointPrimitives → PointPrimitiveColor), `polyline` (3 crossing wide α0.5 polylines → PolylineCollection), `billboard` (3 overlapping α0.5 soft-disc billboards → BillboardCollection). All collection color FS return a `FragOutput` struct handled by the Slice-A `injectOITOutput` struct branch. Per scene: gate-OFF capture, flip `CesiumDebug.webgpuOIT(true)`, gate-ON capture, restore. HARD GATES: `_webgpuOITActiveThisFrame`=TRUE (was ALWAYS false), 0 device/validation errors, gate-ON non-black, gate-ON differs from gate-OFF (non-degenerate WBOIT — the triple-overlap desaturates to gray), restore ≈ noise floor. The `SCENE` env (`point`/`polyline`/`billboard`) selects one (default all) — run ONE per Edge session for machine safety (3-min watchdog). Writes `output/oitcoll-*.png` + `oitcoll-report.json`. Run after any change to the collection OIT wiring in `WebGPU{Billboard,PointPrimitive,Polyline}Renderer.js` or `WebGPUOIT.injectOITOutput`. |
| `probe-oit-model-reachable.mjs` | **C11-157 Slice C — translucent MODELS now reach WebGPU MRT-OIT (WebGPU-only, gate-flip).** Two tileset scenes at `msaaSamples=1`: `twin` (BatchedWithBatchTable + a subset-translucent per-feature style → the OPAQUE primary + a BLEND-class TRANSLUCENT twin, C10-02/Batch 699) and `blend` (BatchedTranslucent → natively-BLEND primary command). Both model color FS return a `FragOutput` struct → the Slice-A `injectOITOutput` struct branch (posField `fragCoord`). HARD GATES (REACHABILITY): `_webgpuOITActiveThisFrame`=TRUE (was ALWAYS false), 0 device/validation errors (also covers the Batch-704 async ready-gate — 0 warmup errors), gate-ON renders via the OIT composite (non-black, doesn't vanish), restore ≈ noise floor. `onVsOff` is RECORDED not gated: model geometry is single-sided (back-face culled) + non-overlapping → WBOIT ≡ sorted-alpha (0 diff is CORRECT; the visible desaturation is inherited-proven from Slices A/B on the shared composite). The `SCENE` env (`twin`/`blend`) selects one (default both) — run ONE per Edge session (3-min watchdog); tileset loads are slow so give ≥250s. Writes `output/oitmodel-*.png` + `oitmodel-report.json`. Run after any change to `WebGPUModelPipelineCache.{getOITColorConfig,_composeColorSource}`, the model OIT attach in `WebGPUModelRenderer.ts`, or `executeOITCommand`/`resolveOITBuffer`. |
| `diag-globe-belowsurface-decomp.mjs` | **Below-surface darkening A/B term decomposition (NEW-GLOBE-BELOWSURFACE-DECOMP, B2 of the darkening epic).** Runs the failing below-surface scenarios (underground-red / underground-def / translucent-space / translucent-terrain) on WebGPU with each candidate shading term individually bypassed via the `bypass-*` globe-fragment debug modes (underground tint, translucency alpha, ground-atmosphere drape, B506 seam clamp, B506 glint, fog), all captured from a single page load so tile state is identical, and emits a per-term signed-dRGB attribution table (own contribution vs `bypass-none` control + toward-WebGL residual movement) naming the dominant contributor for B5. Diagnostic, not a parity gate — exits 1 only if the bypass instrumentation is dead. Writes `output/diag-belowsurface-report.json`. |
| `probe-globe-clippoly-geodetic.mjs` | **`globe.clippingPolygons` end-to-end gate (GLOBE-CLIPPOLY-GEODETIC, Batch 494), webgl-vs-webgpu.** A clipping polygon over the globe: clipped-region and inverse-mode pixel parity via screenshot diff, plus the default off-gate (no polygons → `clippingPolygonControl` zero, clip path skipped, rendering unchanged). Guards the whole B494 wiring chain: `packDataForFeatureRenderer()` (the shared CPU pack — spherical `fastApproximateAtan2` coords + merged extents), the upstream `[header\|extent×2\|vertices]` rg32float upload + canonical `PolygonSignedDistance.wgsl` compute in `WebGPUClippingPolygonCollection.ts`, the effects-bind-group producer-field read, and `globeClipByPolygon(v_positionMC)` in `GlobeTerrain.wgsl` — a verbatim parity port of `modelClipByPolygon` using the SPHERICAL fast-atan convention matching `czm_approximateSphericalCoordinates` (NOT geodetic conversion, which would mismatch upstream). Run after touching any of those, the SDF atlas sizing, or the `EffectsUniforms` clipping tail (whose byte-parity padding also fixed the latent Batch-108 `pointLightControl` misalignment). |
| `probe-lake-water-mask.mjs` | **`globe.lakeWaterMask` acceptance + off-gate (C7-LAKE-WATER-MASK, WaterClassificationProvider Phase 1).** Two modes run around a rebuild: `baseline` captures flag-OFF views (Lake Michigan / Superior / Michigan-shoreline / open-ocean / Nebraska-land, both backends) against the pre-change build; `accept` re-captures OFF + ON and gates (a) OFF vs baseline ≈ 0% (byte-identical default), (b) ON-vs-OFF: water effect appears on lake views (>=3%), land unchanged, ocean unchanged within wave-phase noise, (c) cross-backend ON mismatch stays in the OFF regime. Guards the Natural Earth lake-mask composite at the shared water-mask upload point (`GlobeSurfaceTile.js`), the `Globe.lakeWaterMask` accessor, and the bundled `Assets/WaterMask/ne10mLakes.bin` fetch. READ the on-* lake PNGs (shoreline AA is a visual check). |
| `probe-large-lake-water.mjs` | **NS-LARGE-LAKE-WATER-MASK root-cause probe (Batch 632).** Samples `terrainData.waterMask` directly at Great Lakes / ocean / land points (proves Cesium World Terrain marks lakes as LAND — provider data limitation, the motivation for `lakeWaterMask`) + captures a Lake Michigan view on both backends. |
| `probe-water-mask-coast-aa.mjs` | **Coastline screen-space AA gate (NS-WATER-MASK-COAST-AA, Batch 631).** Dalmatian-coast before/after captures on both backends; gates that coast-band high-frequency (Laplacian) energy drops and the change stays localized to the coast. Run `before` → rebuild → `after` when touching the water-mask AA band in `GlobeFS.glsl` / `GlobeTerrain.wgsl` or the water-mask upload path. |
| `probe-ocean-wave-lod.mjs` | **C11-172 ocean-wave PHYSICAL-WAVELENGTH LOD acceptance (2026-07-24), webgl+webgpu.** Two lanes over open North-Pacific ocean at a pinned clock: LOW (~50 m, horizon in frame) and MID (~20 km). Splits the ocean region into distance bands (rows) and measures per-band high-frequency luminance variance (variance of a 4-neighbour Laplacian) — the maintainer screenshot's failure metric. LOW gates: far band calms below a ceiling AND below the near band (not noise to the horizon), near band shows resolvable wave structure (bounded, not per-pixel noise) that ANIMATES (frame-driven temporal delta, per backend), near band lit. MID gate: ocean renders lit + not all-flat + not noise. ALL lanes: `scene.context.rendererType` MUST equal the requested backend (a silent WebGPU→WebGL fallback fails hard). Captures CANVAS-only PNGs (same-task `toDataURL`, no app chrome). Guards the ellipsoid-UV physical-wavelength march + `textureSampleGrad`/aniso + amplitude fade + hard cutoff in `GlobeTerrain.wgsl`::`sampleOceanWaveNormals`, the GLSL twin in `GlobeFS.glsl`::`computeWaterColor`, and the ocean sampler `maxAnisotropy` in `WebGPUGlobeSurfaceLayouts.ts`. Thresholds are advisory; READ the PNGs. Companion pure spec: `ocean-wave-lod.spec.mjs` (`node --test` — pins the shared fade band + cutoff WGSL↔GLSL and the LOD-curve shape, extracting wavelengths/weights FROM the shaders). |
| `probe-ocean-datum.mjs` | **CWT ocean-lid VERTICAL DATUM survey (Batch 759, TIDES/OCEAN-DYNAMICS W0), webgpu.** Three lanes: (1) `sampleTerrainMostDetailed` at six open-ocean sites spanning the EGM2008 undulation range + fixed levels 4/8/11 as an LOD-dependence detector; (2) the FFT patch anchor vs the CWT waterline at the Sri Lanka coast, with an OFF/OFF/ON canvas control so a 0 m offset from an ABSENT patch cannot read as agreement; (3) `globe.getHeight` at exaggeration 1.0 vs 3.0 with `sampleTerrain` as the invariant control. **Answered: lid = GEOID** (slope 1.049 vs EGM2008, r² 0.999, spread 171 m), patch floats **101.64 m** above the baked sea, exaggeration DOES displace the lid. Reading guide + decision tree: `migration_doc/OCEAN_DATUM_PROBE_DESIGN_2026-07-24.md`. Classification math: `lib/ocean-datum-model.mjs`, pinned by `ocean-datum.spec.mjs` (39 tests). Exit 0 = clean answer, 1 = MIXED branch (a real result), 2 = structural. |
| `probe-ocean-tide-datum.mjs` | **C6-FFT-OCEAN-TIDE-DATUM slice-1 ACCEPTANCE (Batch 763), webgpu.** Sibling of `probe-ocean-datum.mjs` — that one measured the defect, this one accepts the fix. Four lanes: **(a) datum fix** at the Sri Lanka coast with BOTH halves measured in the same run (the "before" comes from pinning `oceanVerticalDatum = "ELLIPSOID"`, not from trusting the archived number; the archived −101.64 m is still checked, and a baseline that fails to reproduce it declares the comparison un-anchored). PNG pair `ocean-tide-datum-{before,after}.png` — **READ THEM**. **(b) tide phase**: a pinned-clock 25 h ladder reading the RENDERED `tideHeightMeters` plus the model at the same instants (equal ⇒ the T6 scene-clock lock; anything on wall time fails), lunar-only maxima vs lunar culmination (≤5 min), mean lunar period vs the published NOAA **M2** constituent 12.4206 h (12.00 h ⇒ S2, fail), spring/neap peaks vs Sun–Moon elongation over 90 days. **(c)** `scene.verticalExaggeration` 1.0 vs 3.0 asserting `h' = (h−rel)·scale + rel` on the published anchor height. **(d)** off-contract: `tideEnabled=false`, a zero `tideCallback`, and `verticalDatum="ELLIPSOID"` each give EXACTLY 0. Thresholds + verdicts: `lib/ocean-tide-datum-model.mjs`, pinned by `ocean-tide-datum.spec.mjs` (25 tests, includes the grid-vs-measured-CWT cross-check and the "no WGSL/renderer change" guard). |
| `probe-wgs84.mjs` | WGS84 ellipsoid + default imagery at orbit and 1Mm-close |
| `probe-wgs84-quick.mjs` | Fast orbit-only diff for the catastrophic-rendering case |
| `probe-wgs84-atmo.mjs` | Ground-atmosphere drape internals (uses globeFragmentDebug modes) |
| `probe-wgs84-postcomposite.mjs` | Post-composite imagery color/alpha |
| `probe-wgs84-varyings.mjs` | Per-vertex atmosphere varyings |
| `probe-wgs84-layer1-alpha.mjs` | Layer 1 reprojection alpha |
| `probe-wgs84-alphadbg.mjs` | Layer 0 reprojection alpha |
| `probe-wgs84-sample0.mjs` / `-close-postfix.mjs` | Raw layer-0 sample / close-zoom regression check |
| `probe-projection-fix.mjs` | Eight orbital views (north-am, arctic, equator, asia, southern, europe-mid, tile-edge, dusk-pacific) for projection-chain verification |
| `probe-imagery.mjs` / `-imagery-format.mjs` / `-imagery-tex.mjs` | Imagery format / texture upload paths |
| `probe-imagery-overlay.mjs` | **Regression check for Batch 56 alpha=1.0 reprojection fix.** Adds a transparent overlay (TileCoordinatesImageryProvider) on Bing — if the fix broke transparency the WebGPU side shows opaque colored boxes instead of just labels. |
| `probe-atmosphere-toggle.mjs` | **Regression check for Batch 56 per-fragment ground atmosphere fix.** Captures with `globe.showGroundAtmosphere = true/false` at 18 Mm. Verifies both modes render correctly (atmosphere ON not catastrophic; atmosphere OFF not silently broken). |
| `probe-ground-atmosphere.mjs` | **Automated ground-atmosphere gate (Batch 239** — verified the separate-pass renderer deletion left the live in-`GlobeTerrain.wgsl` path intact). WebGPU, 18 Mm, skyAtmosphere HIDDEN: asserts (A) lit globe non-black px > 20k, (B) ON→OFF in-session toggle diffs > 1.5k px (the in-shader veil contributes), (C) retired FR key 29 unregistered, (D) 0 errors. Gotcha baked in: WebGPU `tilesLoaded` goes true ~frame 61 while imagery upload is still in flight — needs 300-frame floor + 60 consecutive loaded frames. |
| `probe-globe-material.mjs` / `-globe-tile-trace.mjs` / `-globe-timing.mjs` | Globe material + tile selection / timing |
| `probe-globe-bindgroup-cache.mjs` | **Regression gate for the Batch 241 per-tile bind-group cache** (NEW-GLOBE-BINDGROUP-CACHE) — run after ANY change near `WebGPUGlobeSurfaceRenderer` bind groups, the imagery texture cache, or the uniform ring allocator. Asserts: fixed-camera steady state 0 creates/frame at >10 requests/frame (reads `globalThis.__webgpuGlobeBindGroupCache` counters — needs the unminified/dev build, counters are pragma-stripped in prod); pan spikes creations then re-settles to ~0; globe visually present (non-black + imagery color diversity); 0 console/validation errors. Gotcha baked in: `tilesLoaded` is true while the imagery provider async-initializes AND while globe pipelines async-materialize (zero bind-group requests both windows) — the settle gate requires the request counter actively ticking every frame of the streak. |
| `probe-globe-default-limits.mjs` | **Regression gate for the Batch 246 default-limit globe layout** (NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT) — run after ANY change to the globe bind-group layouts, the effects BGL's sampled-texture count, `GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES`, or `GlobeTerrain.wgsl`'s group-1 declarations. Builds its OWN CesiumWidget on a bare page (the device pool would otherwise share a high-limit primary device) with `contextOptions.requiredLimits` pinning `maxSampledTexturesPerShaderStage: 16`; asserts the device reports 16, the renderer selected the 1-slot reduced layout (`globalThis.__webgpuGlobeImagerySlotCount === 1`), the globe renders offline NaturalEarthII imagery (non-black + color buckets), a second (grid) layer composites via the 1-slot multi-pass blend path (green-wash shift), and 0 console/validation errors. SwiftShader cousin: `node Tools/variant-smoke-test.mjs --variant dual --browser msedge --webgpu-adapter swiftshader` runs the same scenario on a REAL spec-floor adapter. |
| `probe-disk-bleed.mjs` / `-disk-bleed-scan.mjs` / `-disk-extent-state.mjs` | Edge / horizon bleed artifacts |
| `probe-fog-state.mjs` / `-particle-no-fog.mjs` | Fog branch state inspection |
| `probe-dusk-terminator.mjs` | Day/night terminator rendering. **Rebuilt Batch 160** onto the CesiumViewer driver (`?renderer=` + `window.viewer` + `PROBE_BASE`) — the original Sandcastle renderer-override shim never captured the async WebGPU viewer, so it silently "passed" on a blank WebGPU frame. Now genuinely exercises both backends (WebGL 1.48:1, WebGPU 1.43:1 lit/unlit hemisphere ratio). |
| `probe-vr2-tile-brightness.mjs` | Per-tile brightness anomaly at regional altitude (largest adjacent-block luminance jump, WebGL vs WebGPU). NEW-VR2-7 reproduction (no longer reproduces). `PROBE_DARK=1` toggles globe lighting off for the suspect test. |
| `probe-darkness-quant.mjs` / `-gamma-chain.mjs` | Brightness / gamma chain isolation |

### Scene mode / camera

| Probe | What it covers |
| --- | --- |
| `probe-2d-cv-modes.mjs` | SCENE3D, COLUMBUS_VIEW, SCENE2D with `morphTo*(0)` |
| `probe-mode-roundtrip.mjs` | 3D→CV→3D, 3D→2D→3D round-trips (split-globe artifacts) |
| `probe-2d-zoom-globe.mjs` | **2D regional vs full-globe tile-count + frustum diff** (WebGL vs WebGPU). Entry-point diagnostic for "globe blank in 2D": confirms tile selection + frustum parity so you look downstream (it did — the real bug was an execution-time cull, NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM / Batch 167). |
| `probe-2d-globe-render.mjs` | **Regression guard for the Batch 167 globe-2D-zoom fix.** Regional + full-globe 2D lit-pixel ratio WebGL vs WebGPU. WebGPU was ~0 px at regional 2D before the fix (3D-ECEF bounding volume culled against the 2D projected frustum); now ~1.07× WebGL. |
| `probe-camera-construct.mjs` / `-camera-issue.mjs` | Camera UB construction |
| `probe-canvas-timing.mjs` / `-canvas-vs-screenshot.mjs` | Headless canvas readback timing |
| `probe-cesium-viewer.mjs` / `-cesiumviewer-screenshot.mjs` | CesiumViewer-level smoke |
| `probe-demand-canvas-pass.mjs` | **The canvas-pass demand-open gate (C9-07 / FAR-405-C0, 2026-07-16) — run after ANY change to `WebGPUContext` beginFrame/endFrame/clear/`_beginDefaultRenderPass`/`resumeDefaultRenderPass`, the scene-FB redirect, or the post-process tail.** Both backends, offline boot: default globe presents; EMPTY scene (globe/sky/sun/moon hidden, frozen clock, DOM overlays hidden) canvas byte-compared against the `-PRECHANGE` capture (run once with `PHASE=pre` to refresh baselines); request-render retains the last frame while idle (waits for frame-number stability — WebGPU has a legit multi-second warm-up tail of requestRender calls) and updates after `requestRender()`; mid-run resize; `CesiumDebug.showDepth/showFrustums` present. Allowlists ONE pre-existing resize validation error (`SceneFramebuffer-Color_depth_resolve_ss` sample-type race — NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION family). Writes `output/demand-canvas/*.png`. The signature failure it exists to catch: a black canvas with zero console errors (endFrame fallback clearing after the PP blit, or a first-open clear wiping overlay output). |

### Collections (billboard / point / label / polyline / cloud / compute-instance)

| Probe | What it covers |
| --- | --- |
| `probe-collections-regression.mjs` | **THE consolidated collections gate (Batch 236, NEW-COLLECTION-RETOUCH-PROBE) — run this after ANY change near the collection renderers, the dirty lifecycle, or the resident-instance manager.** All five collections in ONE close-camera scene (11 km, globe/sky hidden), five checks: (1) each collection renders its own saturated color (billboard=magenta, point=cyan, label=yellow, polyline=red, cloud=green); (2) settled re-touch — monkeypatched `_update<X>` entry points (incl. label glyph/background billboard children) = 0 calls over 20 frames; (3) upload gate — billboard/point/label manager counters 0/0/0 over the same frames; (4) one mutated primitive of each kind renders at its new window within 2 frames; (5) 0 console errors. Deterministic; writes `output/collections-regression-{before,after}.png`. Subsumes the settled/re-touch/upload halves of the four probes below (keep those for their finer-grained assertions: exact stride bytes, full-vs-partial path, TAA). |
| `probe-polyline-cloud-consume.mjs` | **Regression guard for Batch 228 dirty-consume** (NEW-DIRTY-CONSUME-POLYLINE / -CLOUD): settled `_updatePolyline`/`_updateCloud` 0/frame, queues drained, a modified polyline still re-enqueues, polylines render. Also caught NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH (Batch 228) and NEW-CLOUD-SCALE-METERS (Batch 253 — its 2 km clouds at a 1.5 Mm camera blew up to full-screen white once the log-depth flip let them win the depth test, exposing the pixels-instead-of-meters quad sizing). |
| `probe-cloud-property-edit.mjs` | **Regression guard for the Batch 233 cloud rebuild gate** (NEW-CLOUD-REBUILD-DIRTY-GATE): clouds against a black background; edit one cloud's position+scale → rendered mask changes within 2 frames + instance buffer rebuilt; settled frames after the edit → 0 further rebuilds; 0 console errors. Reproduced the pre-fix staleness exactly (changedPixels=0, no rebuild). Re-parameterized in Batch 253 (NEW-CLOUD-SCALE-METERS): cloud scale is METERS now, so the scene moved from 220x150 "px" clouds at 300 km to 2000x1300 m clouds at 15 km. |
| `probe-collections-far-camera.mjs` | **The far-camera log-depth gate (Batch 251, NEW-COLLECTIONS-LOG-DEPTH).** Billboards + points 1000 m above a VISIBLE solid-color globe at a 220 km camera WITHOUT disableDepthTestDistance — the original "bug 2" depth-tie case that was impossible pre-log-depth. Asserts: markers render with log depth ON; a below-ground negative control stays occluded (depth test intact); a runtime kill-switch leg (`context._logDepthWriteEnabled = false`) reproduces the historical vanish then flips back green (exercises every renderer's flip-rebuild guard); reports ON/OFF avg frame cost; 0 console errors. Run after ANY change to depth encoding, the LOG_DEPTH define plumbing, or a new depth-writing pipeline family. Writes `output/collections-far-camera-{on,off}.png`. **Flake FIXED (Batch 267):** the prior intermittent FAIL (`red>0` AND the kill-switch leg failing to vanish together) was a probe-settle race — the globe occasionally skipped its draw in the captured frame, emptying the depth buffer so below-ground markers leaked through (NOT a log-depth regression: a good settle always gives `red=0`). The probe now `snapWithGlobe`-gates every capture on a non-black globe center pixel + asserts an explicit `(2g)` globe-present precondition, so the negative control only runs against a present globe. Verified 3/3 green post-fix. |
| `probe-logdepth-zfight.mjs` | **The Mat/PBR/Basic primitive log-depth gate (Batch 264, NEW-PRIMITIVE-MAT-LOG-DEPTH) — leg 1 of the 3-probe "full z-fight gate" (with `probe-buffer-logdepth-zfight` + `probe-ellipsoidprim-logdepth`, run all three for the log-depth final-sweep verification).** A green slab grid rendered via `MaterialAppearance` (ColorMaterial → the Mat pipeline — the NEW log-depth producer) near-coplanar with a solid globe at a 220 km nadir camera, plus a magenta billboard reference grid (already log-depth). Asserts: the Mat slab renders with log depth ON; ON/OFF green-pixel ratio ≥ 0.9 (the pre-fix mixed-depth bug — globe-log + slab-hyperbolic — lost ~28% of slab pixels, ratio ~0.72); a below-ground negative control stays occluded; the kill-switch flip back ON re-verifies (exercises the Mat-pipeline flip-rebuild guard); 0 console errors. The magenta markers render ONLY with log depth ON (the OFF/all-hyperbolic leg vanishes them at 220 km) — the visual tell that the depth regime engaged. Run after ANY change to the Mat/PBR/Basic shaders, the FLAT/LIT camera-UB logDepth tail, or the LOG_DEPTH define gating in `WebGPUPrimitiveCommands`. Writes `output/logdepth-zfight-{on,off}.png`. **Flake FIXED (Batch 267):** same settle race as the far-camera probe — the below-ground control intermittently FAILED (`green>40`) when the globe skipped its draw in the captured frame (empty depth buffer). Now `snapWithGlobe`-gated on a >25% non-black baseColor fraction + an explicit `(3g)` globe-present assertion; also stabilized the slab green count. Verified 4/4 green post-fix. |
| `probe-buffer-logdepth-zfight.mjs` | **The Buffer* collection log-depth gate (Batch 265, NEW-BUFFER-LOG-DEPTH).** A cyan BufferPoint grid + yellow BufferPolygon slab + red BufferPolyline a few hundred meters above a solid globe at a 220 km nadir camera, with a magenta BillboardCollection grid co-located at the same 36 positions as a KNOWN-GOOD log-depth reference. Asserts (all in the default log-depth-ON state — it does NOT rely on a kill-switch OFF leg, which blacks the globe mid-session — pre-existing limitation): all three Buffer families + the billboard ref render; the cyan Buffer coverage is ≥ 40% of the magenta reference (post-fix ≈ 0.49-0.51 — both compose on the log globe); an off→on flip rebuilds with no validation error; 0 console errors. Against the PRE-fix build it fails hard — cyan/yellow/red = 0 (all Buffer fill eaten by the log globe) while the magenta ref stays — the reproduction. Run after ANY change to the Buffer* shaders, `WebGPUBufferPrimitiveRenderer` chunk map / `preprocessShader` / `packCameraUniforms`, or the per-collection Buffer renderers' LOG_DEPTH gating. Writes `output/buffer-logdepth-zfight.png`. |
| `probe-ellipsoidprim-logdepth.mjs` | **The EllipsoidPrimitive log-depth gate (Batch 266; upgraded to a FULL PIXEL probe Batch 269 after BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE was fixed).** Places an EllipsoidPrimitive over a settled globe and asserts: renderer-wide log depth active, the LOG_DEPTH pipeline builds, the ellipsoid renders **green pixels** with log ON (~18280), the kill-switch OFF leg rebuilds the hyperbolic pipeline with ON≈OFF coverage (ratio 1.000), the flip-rebuild guard toggles `_pipelineLogDepth` across ON→OFF→ON, a FAR (6000 km) camera composites the ellipsoid against the log globe with NO terrain bleed-through, and 0 console/WebGPU validation errors. The three Batch-269 root causes it now guards: `_computedModelMatrix` hoisted above the FR branch (was an all-zeros non-invertible matrix → mid-pass throw), the renderer reads `_computedModelMatrix` not raw `modelMatrix` (center was dropped), and the FS ray-casts a radii-scaled bounding-box (the old FOV-less screen quad discarded every fragment). Run after ANY change to `WebGPUEllipsoidPrimitiveRenderer` LOG_DEPTH gating / camera-UB layout / the box-ray-cast VS+FS. **Translucent double-blend sibling:** `probe-ellipsoidprim-translucent.mjs` (Batch 276, BUG-ELLIPSOIDPRIM-WEBGPU-TRANSLUCENT-DOUBLE-BLEND) — an alpha-0.5 shell's translucent/opaque mean-green ratio must be single-blend (~0.499, NOT the pre-fix 0.748 double-blend) via `cullMode:"back"` + a real `boundingVolume` + `executeInClosestFrustum` + `Pass.TRANSLUCENT` routing. (The Vector3DTile classifiers — Batch 266 NEW-CLASSIFIER-LOG-DEPTH — have NO probe: pixel-verify is blocked on absent `.vctr` test data; they are verified-by-analysis against the proven GroundPrimitive pattern + build-green + 0 validation errors.) |
| `probe-billboard-partial-write.mjs` | **Regression guard for the Batch 229 resident-instance manager + billboard wiring** (NEW-RESIDENT-INSTANCE-BUFFER-MGR / NEW-PARTIAL-WRITE-WIRE-BPL): 1000 settled billboards → 0 uploads over 30 frames; 1 moved → exactly 1 partial write of 1×176 B stride, renders at the new position. Reads the manager's debug-pragma counters (`_fullRebuilds`/`_partialWrites`/`_bytesUploaded`). Header documents the depth-precision envelope (camera ≤ ~10 km — see NEW-COLLECTIONS-LOG-DEPTH). |
| `probe-resident-instance-prev-mirror.mjs` | Manager `mirrorPrev` (velocity prev-buffer) write contract via intercepted writes (Batch 229). The live TAA consumer went live in Batch 234 — see `probe-taa-velocity-emission.mjs`. |
| `probe-taa-velocity-emission.mjs` | **Regression guard for the Batch 234 canonical `frameState.taaEnabled` publication** (NEW-COLLECTIONS-TAA-GATE-DORMANT): TAA OFF→ON→OFF with moving billboards + points. OFF → no `velocityCommand`, velocity texture unallocated, msaa=4; ON 60 frames → velocityCommand attached on billboard + point color commands with the slot-aligned prev buffer as the 2nd vertex stream, velocity texture allocated, msaa forced to 1 (TAA↔MSAA contract), 0 console/validation errors; OFF → commands detach, msaa restored. |
| `probe-point-label-partial-write.mjs` | **Regression guard for the Batch 232 point + label manager wirings** (NEW-PARTIAL-WRITE-WIRE-BPL remainder): 1000 points + 200 labels settled → 0 uploads on both managers; 1 moved point → exactly 1 partial write of 1×112 B; 1 label text change → full rebuilds only (never partial — glyph granularity is unsound for per-slot writes) with the new text rendered; cross-collection isolation (label edit doesn't touch the point manager). |
| `probe-collections-morph-blend.mjs` | **Phase 3 Slice 3 morph-blend gate (NEW-COLLECTIONS-2DCV-PROJECTED-FRAME-RTE morph leg).** Drives an ANIMATED `morphTo2D` / `morphToColumbusView` (NOT instant — the sibling `probe-collections-2dcv-morph.mjs` only does `morph*(0)` and so never enters `SceneMode.MORPHING`), re-asserts a fixed top-down 8 Mm camera EVERY frame so framing is constant, bins billboard/point/label coverage by the live `scene.morphTime`, and asserts no GPU bin vanishes where WebGL substantially shows the marker (>30 px floor avoids near-horizon false triggers). Proves billboard/point/label track smoothly through the transition (the morph blend is CPU-side in `SceneTransforms.computeActualEllipsoidPosition`, so no WGSL dual-stream path is needed for these collections — unlike the globe/PolylineCollection). `PROBE_NOGLOBE=1` isolates position tracking from the globe depth test. Uses a 64px source billboard to stay above the NEW-BILLBOARD-SIZE-PARITY detection floor. Run after any change to the collection camera UB, `repackPerSlice`, `_actualPosition` packing, or morph plumbing. |
| `probe-bb-cv-diag.mjs` | **Reproducer for NEW-BILLBOARD-SIZE-PARITY.** A single 64px magenta billboard at 50 km, globe OFF, top-down 8 Mm camera, in steady 3D / 2D / CV (instant morphs) — reports magenta px per backend. WebGPU renders billboards at ≈¼ the area of WebGL in ALL modes (≈961 vs ≈4032). Use to bisect a billboard quad-expansion / size-term fix. |
| `probe-2d-frustum-bins.mjs` | **Multi-frustum binning diagnostic (Batch 268, NEW-SCENE2D-GLOBE-PASS-OVERWRITE).** In SCENE2D with the globe shown, dumps `View.frustumCommandsList` — the per-frustum near/far split, how many GLOBE/OPAQUE/TRANSLUCENT commands bin into each frustum, the billboard command's `computePlaneDistances` extent, the rendered tile levels, and (via a `createPotentiallyVisibleSet` hook) how many commands have NO `boundingVolume` + the scene min-near. Run with `webgl` or `webgpu` arg to compare. This is the tool that root-caused the SCENE2D marker-overwrite: WebGPU's globe commands without a bounding volume forced a 9-way frustum split (vs WebGL's 1) so nearer-frustum opaque globe overwrote the far-frustum-binned coplanar markers. Use whenever a 2D/CV overlay disappears behind the globe or the frustum count diverges from WebGL. |
| `probe-frustum-count-3d.mjs` | **Default-3D frustum-count parity gate (C10-01, ENV-COMMAND-FRUSTUM-BINNING).** Records `scene.numberOfFrustums` for WebGL vs WebGPU at three route altitudes (18,000 km / 500 km / 300 m) plus a sky-only leg, with per-frustum `ENVIRONMENT`/`GLOBE` bin counts (captured via a `createPotentiallyVisibleSet` hook BEFORE SceneRenderer injection) and canvas pixel stats + PNGs. Asserts WebGPU count `=== 1 === WebGL` on default 3D (pre-C10-01 WebGPU floored at 2 because BV-less `Pass.ENVIRONMENT` commands widened near/far to the log-depth camera span `[0.1, 1e10]`). Sky-only leg keeps `>= 1` frustum with stars visible. Run `both` (default), `webgl`, or `webgpu`. Use whenever the default 3D frustum count diverges from WebGL or a BV-less env producer is added. |
| `probe-orbital-catalog.mjs` | **Regression gate for the compute-instance system** (Batch 230/231) driving the orbital demo kernel: 2000 GPU-resident instances render + move with CPU uploading only a time scalar. |
| `probe-compute-instance-generic.mjs` | Feature-agnosticism proof for the compute-instance system (Batch 231): NON-orbital rotating-Lissajous kernel renders + moves. Run together with `probe-orbital-catalog.mjs` after any change near `ComputeInstanceCollection` / `WebGPUComputeInstanceRenderer`. |
| `probe-orbital-j2.mjs` | **df64 precision gate (Batch 277, NEW-ORBITAL-J2-KERNEL).** Composes the SHIPPED scaffold WGSL + the secular-J2 demo kernel (df64) AND an f32 control, dispatches both on a probe-owned device vs a JS FP64 reference at a 30-day propagation: asserts df64 LEO error < 1 km (~15 m measured) AND df64 beats f32 by ≥ 5× (~145× measured). Run after touching the `csm_df64_*` helpers in `ComputeInstanceScaffold.wgsl`. |
| `probe-orbital-sgp4.mjs` | **Near-earth SGP4 accuracy gate (Batch 278, NEW-ORBITAL-SGP4-KERNEL).** GPU df64 SGP4 kernel (`Tools/visual-regression/sgp4-kernel.mjs`, CPU FP64 pre-conditioning in `sgp4-reference.mjs`) vs EMBEDDED python-sgp4 2.25 reference vectors (ISS/NOAA-19/Starlink): asserts worst ECEF error < 2 km over a full day (~55 m measured), a deep-space GPS TLE is flagged + skipped, 0 errors, AND the demo's runtime path (real `ComputeInstanceCollection`) renders + moves. The JS FP64 reference is itself bit-validated vs python-sgp4 (0.0000 m) by `validate-sgp4.mjs` (a dev gate, needs `pip install sgp4`). Demo: Sandcastle "WebGPU SGP4 Satellites". |
| `probe-orbital-1m.mjs` | **1M-instance device-limits validation gate (Batch 281, NEW-ORBITAL-DEVICE-LIMITS-PROBE).** Validates the compute-instance system scales to a literal 1,000,000-object catalog within WebGPU limits with NO multi-SSBO split. Acquires a probe-owned device with explicit maxed `requiredLimits`, composes the SHIPPED `ComputeInstanceScaffold.wgsl` + a golden-angle-shell kernel + the SHIPPED `ComputeInstanceRender.wgsl` (defines=0, LOG_DEPTH ifdef-stripped inline), dispatches 15,625 workgroups @ 1M, renders the instanced quads to an offscreen target and reads back. Asserts (A) 1M fits a single storage binding for records/params/pick SSBOs + the single-dim `ceil(N/64)` dispatch (caps at 4,194,240 instances) + ≥64 invocations/WG — no split needed; (B) the achieved count dispatched within limits + rendered a dense shell (21,064 cyan px @ 1M); (C) 0 validation errors. `PROBE_1M_COUNT` overrides the target; backs off to a VRAM budget on a small adapter. Run after touching `WebGPUComputeInstanceRenderer` buffer allocation, the scaffold dispatch, or `WebGPUDevicePool` limit negotiation. |
| `probe-compute-instance-pick.mjs` | **GPU-pick gate for storage-buffer compute-instances (Batch 279, NEW-ORBITAL-GPU-PICKING).** Three instances at fixed ECEF; `scene.pickAsync` over each returns its OWN `instanceIndex` (0→0, 1→1, 2→2, accounting for the canvas-Y mirror that `computePickingDrawingBufferRectangle` applies — same convention as PointPrimitiveCollection), empty space returns undefined, the picked record carries only the domain-agnostic `{collection, instanceIndex, primitive}`, the pick pipeline + per-instance pick ids + pick-color buffer are all allocated, 0 console errors. Run after touching the `vertexPickMain`/`fragmentPickMain` entry points in `ComputeInstanceRender.wgsl`, the pick BGL/pipeline/`createPickId` plumbing in `WebGPUComputeInstanceRenderer`, or `allowPicking`. |
| `probe-compute-instance-webgl2.mjs` | **WebGL2 CPU-kernel fallback gate (Batch 280, NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK).** Builds the SAME Lissajous toy on `?renderer=webgl` and `?renderer=webgpu`: (A) WebGL renders (~6400 magenta px), (B) WebGL moves (~179% mask change) via the `cpuKernel` path through `Renderer/WebGLComputeInstanceRenderer.js` (`usedFallback=true`, not the WebGPU compute leg), (C) WebGL≈WebGPU centroid agree to ≤ 8 px (~0.39 px measured) at the same sim time, (D) 0 console/validation errors on both backends. Run after touching `ComputeInstanceCollection.cpuKernel`, `WebGLComputeInstanceRenderer.js`, the `ComputeInstanceWebGL{VS,FS}.glsl` shaders, or the shared FP64 `j2-cpu-kernel.mjs`. |
| `probe-compute-instance-webgl2-demos.mjs` | **WebGL2 demo-polish gate (Batch 283).** Drives the two compute-instance Sandcastle demos ("WebGPU Orbital Catalog" / "WebGPU SGP4 Satellites") on BOTH `?renderer=webgl` (CPU-kernel fallback) and `?renderer=webgpu` (compute), exercising the demos' own `?renderer=` param + the SGP4 demo's new `cpuKernel`. Sandcastle holds the viewer in a local const (no `window.viewer`), so it captures via compositor canvas screenshot + frame-differencing (the globe is static; only the satellite dots flip bright-state) and arms the WebGPU device via the `GPUAdapter.requestDevice` patch (same as sandcastle-smoke). Per (demo, renderer): (A) renders (bright-px floor), (B) moves (≥ N px flip over a ~12 sim-minute window), (C) the right backend ran (webgpu arms a device, webgl arms none — no silent fallback), (D) 0 fatal errors. Run after touching either demo's kernel/cpuKernel/renderer-param, `sgp4-cpu-kernel.mjs`, or the WebGL2 fallback plumbing. |
| `probe-pickmodel-instanced.mjs` | **CPU `pickModel` on instanced models, BOTH backends (Batch 238 upstream #13433 port; WebGPU section REQUIRED since Batch 245, NEW-WEBGPU-INSTANCED-VA-DIVISORS).** [0] Node-level `ModelReader.octDecode` round-trip (no build needed); [1] WebGL BoxInstanced matrix-path: CPU pick hits every rasterized interior pixel + `pickPosition` distance cross-check + empty-center miss; [2] WebGPU: matrix-path AND translation-only instancing render (lit-pixel parity vs WebGL), CPU picks hit all 4 instances at exact +X faces, miss control, 0 errors. Run after touching ModelReader, InstancingPipelineStage, WebGPUModelInstancing, or the VA divisor plumbing. Deterministic lighting: fixed -X headlight, not wall-clock SunLight. |
| `probe-model-pbr-audit.mjs` | **Broad Model PBR asset audit (Batch 141).** Loads CesiumMan (skinned+animated), CesiumMilkTruck (multi-primitive textured PBR), GroundVehicle (KHR_materials_unlit), BoxInstanced (GPU instancing); per asset asserts 0 device errors during render and reports material-UB sizing + passes invoked. Run after WGSL changes to `ModelPBRComplete.wgsl`, the model pipeline cache, or material UB packing (5/5 assets green as of Batch 245). |
| `probe-model-splitter.mjs` | **`model.splitDirection` split-slider discard, WebGL-vs-WebGPU (WIRE-MODEL-SPLITTER).** Milk truck with `splitDirection=LEFT` + `scene.splitPosition=0.5` on BOTH backends: left-of-split coverage present, right-of-split ~empty, coverage masks agree ≤ 12% (measured 0.16%); OFF-GATE `splitDirection=NONE` mask-identical (≤ 2%, measured 0.05%) to a capture that never touches the splitter API; 0 device errors. Run after touching the `MODEL_SPLIT_ENABLED` ifdef blocks in `ModelPBRComplete.wgsl`, `maybeUpdateForSplit`, or the material-UB pad-lane packing (floats 38/39). |
| `probe-model-color.mjs` | **`model.color`/`colorBlendMode`/`colorBlendAmount` gate (WIRE-MODEL-COLOR, Batch 484), webgl-vs-webgpu.** Milk truck with HIGHLIGHT / REPLACE / MIX blend modes plus the untinted default: WebGPU matches WebGL per mode, and models with no `model.color` set compile with the `MODEL_HAS_COLOR` bit clear — the ifdef else-branch is byte-identical to the pre-change shader (off-gate). Guards the `applyModelColor()` block in `ModelPBRComplete.wgsl` (exact `ModelColorStageFS.glsl` math — mix + ceil-highlight multiply + alpha multiply, applied after the customShader hook AND at the unlit early-out), the reserved material-UB lanes (floats 184-187 = color RGBA, float 175 = `ColorBlendMode.getColorBlend` scalar — no BGL change), and `maybeUpdateForModelColor()`. `MODEL_HAS_COLOR` is bit 27 — keySalt-folded per the ≥24-bit module-cache rule. Residual sliver (color.alpha<1 translucent-pass routing, alpha==0 colorMask hide) tracked as WIRE-MODEL-COLOR-ALPHA-SEMANTICS. Run after touching the model-color ifdef blocks, the pad-lane packing, or the keySalt fold in `WebGPUModelPipelineCache.js`. |
| `probe-gltf-points-mode.mjs` | **glTF mode-0 POINTS primitive gate (GLTF-POINTS-MODE, Batch 491), webgl-vs-webgpu.** A point-cloud glTF renders points on BOTH backends (centroids agree ≤ a few px; pre-fix WebGPU drew nothing — all 12 model pipeline builders hardcoded triangle-list). Guards `extractPrimitiveGeometry`'s `defined()`-guarded `primitiveType` carry (POINTS===0 is falsy!), `topologyForPrimitiveType` POINTS→"point-list" mapping + the sticky set-before-getPipeline\* contract, the sequential-index synthesis for NON-INDEXED POINTS prims (WebGPU CPU-validates non-indexed draw() ranges against every vertex-step slot — the 1-element default-attribute buffers hard-fail with "Vertex range requires a larger buffer"), and `topologyVariantKey` threading through all 13 pipeline builders (triangle-list keys stay byte-identical — the off-gate). Parity semantics: WebGL unstyled POINTS = `gl_PointSize` 1.0 = WebGPU point-list fixed 1px. Residuals (LINES/strips, point shadow-casting, ModelPointCloudStylingStage) tracked as GLTF-POINTS-MODE-RESIDUALS. |
| `probe-point-sprite-shape.mjs` | **Point-cloud sprite shape/size/attenuation gate (POINT-SPRITE-SHAPE, Batch 490), webgl-vs-webgpu.** Sprite shape, size, and coverage parity for point clouds + PointPrimitives. Guards the five B490 fixes: point-cloud FS squares (WebGL `gl_Points` are SQUARE unless HAS_POINT_DIAMETER — WebGPU drew soft circles; note WebGL PointPrimitives ARE round, so square parity applies only to point clouds), the real `drawingBufferWidth/Height` viewport (packUniforms read a nonexistent `_context._canvas` and fell back to a phantom 1920×1080 — every sprite ~3× too narrow and 16:9-squished), the per-point size attenuation `min(geometricError/depth · dbh / sseDenominator, maxAttenuation)` via the formerly-padded UBO float (0 = off, the off-gate — applied in all 4 vertex entry points + the EDL depth VS so depth-pass quads stay coverage-identical), the `PointCloud.boundingSphere` WebGPU fallback (getter returned undefined → zeroed TimeDynamicPointCloud's geometricError), and the PointPrimitive WGSL sprite mirroring `PointPrimitiveCollectionVS` exactly (+3.0 AA padding, outlinePercent from unpadded size). Run with the updated `probe-pointcloud-edl-parity.mjs` after touching the point-cloud renderers, `PointCloudEDLDepth.wgsl`, or the PointPrimitive sprite math. |
| `probe-model-scene-modes.mjs` | **glTF model placement in SCENE2D / COLUMBUS_VIEW / SCENE3D, WebGL-vs-WebGPU (MODEL-SCENE-MODES).** Milk truck (globe hidden, black bg) captured per (backend × mode): asserts non-trivial WebGPU coverage (> 200 px — pre-change WebGPU rendered 0 px in 2D/CV: ECEF matrix + ECEF command BV under the projected-frame culling volume), silhouette-mask mismatch < 12% (measured 0.4–0.6%), centroid delta < 20 px (measured 0.1), interior (edge-eroded) channel diff < 24 (allows the pre-existing brightness-scaled warm-vs-cool backend shading residual — 13 on the probe's own 3D leg), 0 device errors. The 3D leg doubles as the off-gate (mode-gated change). Run after touching the mode-aware `modelMatrix`/`commandBoundingVolume` pick in `WebGPUModelRenderer.js`, `ModelSceneGraph.computeModelMatrix2D`, or `packCameraUniforms`. |
| `probe-model-appearance-demo.mjs` | **`webgpu-model-appearance` Sandcastle demo acceptance (NEW-WEBGPU-MODEL-APPEARANCE-DEMO).** New-format gallery `main.js` can't boot standalone (bare `import "cesium"`), so — per the `probe-pp-library-demo` precedent — replicates the demo's exact scenario (milk-truck asset, the same public-API drives as the demo's toolbar controls) in the CesiumViewer WebGPU page and cycles the three B483-485 features with SIGNATURE-pixel gates: red HIGHLIGHT/REPLACE/MIX-@1.0 collapse the model's mean g/b (<20) while MIX-@0.5 half-tints (red up, green in the half-mix band); silhouette LIME@6px adds a lime rim (g>150, r<110, b<110 — the yellow truck can't alias in) the baseline lacks; split LEFT@0.5 empties the right canvas half (<2% of baseline) while the left keeps ≥50%; then the all-defaults restore is BYTE-IDENTICAL to the pre-feature baseline (off-gate), asset serves, 0 console/GPU errors. Also writes the gallery `thumbnail.jpg` source (512×384, mix+silhouette state) to `output/model-appearance-demo/`. Run after touching the demo or any of the three feature probes' subject areas below. |
| `probe-model-silhouette.mjs` | **`model.silhouetteColor`/`silhouetteSize` stencil two-pass rim, WebGL-vs-WebGPU (WIRE-MODEL-SILHOUETTE).** Milk truck with `silhouetteColor=RED` + `silhouetteSize=4` on BOTH backends: red-rim pixel counts agree (ratio > 0.6; measured 0.968 — 3905 vs 4036 px) and the rims mutually overlap ≥ 80% under a 2-px dilation (measured 100%); OFF-GATE `silhouetteSize=0` (color set) matches a capture that never touches the silhouette API within load-to-load noise (measured 0.03% mask / 0.05 chan) with no rim added; 0 device errors. Run after touching the `MODEL_SILHOUETTE` ifdef blocks in `ModelPBRComplete.wgsl`, `ModelSilhouetteStage.wgsl`, `maybeUpdateForSilhouette` / the silhouette pipeline getters in `WebGPUModelPipelineCache.js`, or the material-UB pad-lane packing (floats 105-107 / 112-115). |

### Entity / DataSource

| Probe | What it covers |
| --- | --- |
| `probe-entity-bulk.mjs` | **Entity bulk fast-path gate (Batch 300, NEW-ENTITY-BULK-FASTPATH).** Validates `BulkPointVisualizer`: adding tens of thousands of *static* homogeneous `point` entities via a DataSource/EntityCollection collapses to a single flat point collection (verified ~1300× setup speedup) and still renders. Run after touching `BulkPointVisualizer.js` or the entity-visualizer bulk detection. (WebGPU entity-API point pick gap tracked NEW-WEBGPU-POINT-COLLECTION-PICK.) |
| `probe-entitycluster-gpu.mjs` | **EntityCluster-on-GPU gate (Batch 301, NEW-ENTITYCLUSTER-GPU).** Validates screen-space proximity declutter of a DENSE point set offloads the binning to the GPU while matching the CPU KDBush result. Run after touching `EntityClusterGPU.js` or the declutter binning compute path. |
| `probe-phase12-bugbash.mjs` | **Phase-12 med/low bug-bash gate (Batch 304).** Five checks across BOTH backends: (1) WebGPU globe + Mercator imagery renders with healthy color diversity — gates `NEW-USEWEBMERCATORT-SINGLE-SOURCE` (the `resolveImageryProjection` single-source decision); (2) ZERO `uploadImageSource failed` errors on a healthy device — gates `NEW-UPLOADIMAGESOURCE-OBSERVABILITY` (the permanent error must fire only on real faults); (3) WebGL full-disc sky-atmosphere ring renders blue (the path that compiles the modified GLSL builtin) — gates `NEW-RAYSPHERE-PRECISION-BACKPORT`; (4) a billboard cluster renders on WebGPU — gates `NEW-BILLBOARD-UPDATEMODE-ORDERING` (the `updateMode` dedup must not lose the bounding-volume seed); (5) zero console errors both backends. Run after touching `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileUB.ts`, `BillboardCollection.js`, or `raySphereIntersectionInterval.glsl`. |

### WASM bridges (RTE / Cull / Sort / Heightmap / Matrix / PointCloud / QuantizedMesh)

| Probe | What it covers |
| --- | --- |
| `probe-wasm-bundle-load.mjs` | **THE bundle WASM-load gate (Batch 274, NEW-WASM-BRIDGE-BUNDLE-LOAD) — run after ANY change to a `Wasm*Bridge` loadWasm path, `Scene/resolveWasmGlueUrl.js`, the `ThirdParty/Workers` copy step in `scripts/build.js`, or anything touching how the bundle resolves the wasm-bindgen glue.** Loads the REAL bundle in Edge and for all 7 bridges asserts `loadWasm()→true` + `wasmReady===true`, 0 `cesium_wasm*` 404s (glue + binary both HTTP 200), and a no-fallback trip-wire on the RTE kernel (WASM `batchEncodeRange` byte-identical to the JS twin + `_lastWasmUsed===true` + no "using JS fallback" warning). Runs in ESM mode by default; pass `--iife` to exercise `Build/Cesium/Cesium.js` (the `getBaseUrlFromCesiumScript`/`CESIUM_BASE_URL` branch). This is the BROWSER counterpart of the node-only `Tools/wasm-subrange-encode-check.mjs`. Before Batch 274 the glue/binary 404'd in every bundle and every bridge silently used its JS fallback. |
| `Tools/wasm-subrange-encode-check.mjs` (node) | Standalone Node real-kernel check (no browser): drives the REAL `WasmRTEBridge` via an ESM resolve-hook loader + a fetch shim feeding the on-disk `.wasm`. 18 assertions on `batchEncodeRange` (WASM-vs-JS byte-identity, reference-fround equality, dst-offset placement, untouched-byte preservation, full-range == whole-array `batchEncode`) + a trip-wire that FAILS on any silent JS fallback. The ONLY place the kernel ran before Batch 274. Keep green after any bridge or arena-slot change. |
| `probe-buffercoll-encode-benchmark.mjs` | **End-to-end repack+upload benchmark for the BufferPointCollection POSITION encode (Batch 273, NEW-BUFFERCOLL-ENCODE-BENCHMARK), BOTH backends, 10k/50k/100k points + a visual no-regression assertion.** Measured the position-encode HOIST out of the per-primitive loop as the real win (batch fround over a contiguous Float64Array beats per-point AGI `EncodedCartesian3` by ~25-40% at ≥1500 points on both backends); the threshold was lowered 5000→2000 from this measurement. Run after touching the Buffer* repack path or the WASM-vs-JS encode threshold. |
| `probe-buffercoll-wasm-encode.mjs` | **Parity gate for the BufferPointCollection WASM-batch RTE encode wiring** (Batch 272, NEW-BUFFERCOLL-WASM-ENCODE-WIRE). A 6084-point grid drawn via the batch path vs a forced-scalar twin (`_wasmEncodeThresholdOverride=Infinity`) diffs 0 px WebGPU / 3 px WebGL; sub-threshold + override collections stay scalar (instrumented counters); a full-grid position update re-renders through the batch path. As of Batch 274 the bundle WASM kernel actually runs (`kernel-ran=true`, 0 wasm 404s). |
| `probe-mainthread-encode-ceiling.mjs` | **Phase 13 ECS-worker GATING SPIKE (Batch 305, NEW-ECS-WORKER-GATING-SPIKE) — the GO/NO-GO measurement.** Drives the flat-buffer substrate (`BufferPointCollection`, shared with the compute-instance WebGL2 cpuKernel + entity bulk fast-path) with a full-collection arbitrary position update EVERY frame at 10k/50k/100k/250k on BOTH backends, reads the in-engine repack+upload timer, wall-clocks end-to-end, fits ms = a+b·N and solves the 60/30fps objects-per-frame ceiling. **Result: NO-GO** — the OFFLOADABLE (worker-removable) encode+upload ceiling is ~77-89k @60fps / ~154-187k @30fps (covers tens-of-thousands of arbitrary per-frame updates without a worker); the lower end-to-end ceiling is 56-65% the simulation/nudge loop, which a worker relocates not removes. Regimes 2+3 cover the target → all `NEW-ECS-*` closed. Re-run if the encode/upload path or the WASM-vs-JS threshold changes (the ceiling moves). |

### Classification / ground primitives

| Probe | What it covers |
| --- | --- |
| `probe-classifier-scenemode.mjs` | **Flat-color GroundPrimitive across SCENE3D / 2D / CV, WebGL vs WebGPU** (red-pixel count + device errors). Regression guard for the Batch 161 SCENE3D crash fix and the Batch 164 2D render-pass-crash fix. As of **Batch 170** `ENFORCE_2D = true` — all three modes now ENFORCED (SCENE2D 20781 px / CV 14574 px vs WebGL 20787 / 15484, 0 device errors). The standing regression guard for flat-color ground classification. |
| `probe-classifier-textured-materials.mjs` | **Textured-material GroundPrimitive** (Color / Stripe / Checkerboard / Grid / Image) in SCENE3D, WebGL vs WebGPU. Sub-1° polygon + polygon-interior ROI + lit-pixel-only **variance** signal (flat color → variance ~0; patterned material → high variance). Flat textured-material classification **SHIPPED Batch 185** (`88b111e49c`, `packExtents` wrapper-chain walk). **C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO (2026-07-10): the B375/B595 "textured renders 0 px" re-confirmations were a PROBE-HARNESS RACE, not a classifier regression** — the settle loop exited on `tilesLoaded`, which does not cover the WebGPU globe terrain pipeline's `createRenderPipelineAsync` (~1-2 s wall time), so every WebGPU capture ran against a globe-less scene (cleared packed depth → textured path discards; Color renders volume-bounded over sky). The settle now gates on GLOBE-pass commands reaching the frustum lists, and `ENFORCE_TEXTURED=true`. Canonical acceptance probe: `probe-groundprim-textured-classify.mjs` (next row). NOTE: identical non-zero red-px across all modes is a tell for a JS error-dialog (salmon background), not classification output. |
| `probe-groundprim-textured-classify.mjs` | **C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO acceptance probe** — Color / Stripe / Checkerboard / Grid / Image GroundPrimitive classification on terrain, WebGL vs WebGPU, with per-pixel polygon-ROI convergence (< 25% mismatch), lit-coverage + variance ratios, and the globe-pipeline **readiness gate** (polls frustum-list GLOBE command count; a `tilesLoaded`-only settle races `createRenderPipelineAsync` — see the row above). Guards the 2026-07-10 parity fixes: classifier PRE_MULTIPLIED blend, derivative-based Grid lines (analytic +1px st derivatives), Image material flipY, and the packed-globe-depth no-surface sentinel (`czm_packDepth(1.0) == vec4(0)` parity). |
| `probe-classifier-2d-renderpass.mjs` | Focused diagnostic for **cascading render-pass-lifecycle errors**: drives the 2D GroundPrimitive path, captures the FIRST thrown exception + stack + the leaked render-pass label (not the masking `beginFrame` cascade). Template for `_beginDefaultRenderPass() called with an active render pass` bugs. |
| `probe-classifier-logdepth-flip.mjs` | Stripe GroundPrimitive @ 350 km nadir, **two verdicts**. (1) Slice 3a payoff: WebGL reference vs WebGPU with `_logDepthWriteEnabled` OFF/ON at startup — polygon-interior variance ratio proves the classifier's log-depth eye-z reconstruction. (2) **NEW-WEBGPU-GLOBE-USE-LOG-DEPTH discriminator (Batch 807)**: two extra lanes in **Columbus View with DEFAULT flags** — `Scene.js` clears `useLogDepth` in CV while the master switch stays TRUE, which was exactly the pre-807 defect configuration (globe wrote log, classifiers read hyperbolic). Post-fix the CV WebGPU lane must track the CV WebGL oracle (`varRatio >= 0.3`, `litRatio` in [0.5, 2.0], 0 device errors → `CV PARITY PASS`). PNGs: `ld-stripe-{webgl,webgpu-OFF,webgpu-ON,cv-webgl,cv-webgpu-OFF}.png`. |
| `probe-logdepth-payoff.mjs` | **Wave-B de-risk A/B for `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION`: does the renderer-wide log-depth master switch fix the Checkerboard far-corner reconstruction artifact?** Globe-only scene (only the globe writes depth, so no z-fight from non-logging geometry) + a translucent flat Checkerboard `GroundPrimitive` at 350 km nadir; local variance is measured in the FAR (upper-right) quadrant against the NEAR (lower-left) quadrant of the same frame. **A/B REPAIRED Batch 861+ — every number this probe printed before that repair is void.** Its "switch-OFF baseline" was captured while log depth was ALREADY ON: `isWebGPULogDepthActive` is `context._logDepthWriteEnabled && frameState.useLogDepth` (`WebGPULogDepth.ts:79-84`), `_logDepthWriteEnabled` has defaulted TRUE since Batch 251, `Scene.js:161` `defaultLogDepthBuffer = true`, and `Scene.js:3528` sets `useLogDepth` true for this probe's perspective camera — so BOTH conjuncts held in the "OFF" capture, the A/B was null by construction, and the module contained no predicate and no `process.exit` at all (always 0). It now drives BOTH halves of the switch for the OFF leg (`context._logDepthWriteEnabled = false` AND `scene.logarithmicDepthBuffer = false`, which is what reaches `frameState.useLogDepth`), READS BACK each leg's `active` state after a real render, and requires the two to DIFFER — `Scene`'s `logarithmicDepthBuffer` setter ANDs the request with `context.fragmentDepth`, so a silently-dropped request is now caught. **Exit codes: 0 PASS (ON far-UR variance >= 0.25 x ON near-LL, i.e. the pattern is present) \| 1 FAIL (still solid) \| 2 watchdog or exception \| 3 STRUCTURAL** (the switch did not flip, the scene never settled, or the near-LL reference corner is itself dead). The 0.25 fraction and the 100 near-corner floor are FIRST-PASS values derived from the material contrast, not measurements — the first real run should record the pair and re-baseline if the healthy ON leg lands near the bar rather than far above it. |
| `probe-vr2-polylines-3dtiles.mjs` | BIM Power Plant tileset (ion asset 2464651) + clampToGround classification polyline, WebGL vs WebGPU saturated-panel pixel count (NEW-VR2-5 reproduction — no longer reproduces). Needs network + ion. |
| `probe-vector3dtile-vctr.mjs` | **Vector3DTile `.vctr` e2e, WebGL vs WebGPU** (NEW-VECTOR3DTILE-VCTR-E2E, B8 2026-07-03). Closes the old "no `.vctr` test data" verification gap — that premise was STALE: the upstream Specs fixtures (`Specs/Data/Cesium3DTiles/Vector/**`, 17 tilesets) are served by the dev server. Loads `VectorTilePolygons` (→ `Vector3DTilePrimitive` classifier) + `VectorTilePolylines` on a dark solid globe at nadir (0,0), builds white-pixel masks, gates: polygons FAR-3D IoU ≥ 0.8 (measured 0.904), polylines-3D dilated IoU (measured 1.000), polygons 2D/CV WebGPU presence (Batch 178 — upstream WebGL renders 0 px there), polyline 2D/CV silent skip-gate (ISSUES A.4), 0 device errors at msaa=1. Two frames are **expected-fail-annotated known gaps** that flip to hard gates when fixed: msaa4 frame → `NEW-VECTOR3DTILE-MSAA-PIPELINE` (P1 — pipelines lack `multisample` state; black frame at DEFAULT msaaSamples=4) and NEAR-3D frame → `NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT` (P2 — depth-sample classifier lacks volume-containment; footprint inflates `h/(h-1000)`). See ROADMAP §4.2. |

### Model / glTF

| Probe | What it covers |
| --- | --- |
| `probe-model-tangentgen.mjs` | **Tangent-less normal-mapped glTF (GroundVehicle) derivative-tangent fallback (Batch 159).** WebGL-vs-WebGPU device-error + render guard for `perturbNormal`'s screen-space-derivative tangent path; header documents the same-backend A/B (vs the flat-normal fallback) for re-measuring the restored normal-map detail. |

### Shadows / CSM

| Probe | What it covers |
| --- | --- |
| `probe-csm-cast-dispatch.mjs` | **CSM cast-dispatch gate (Batch 296, NEW-CSM-CAST-NO-DISPATCH-VIEWER).** Confirms WebGPU shadow CAST commands actually reach the cast pass and a depth texture is populated — the half of the CSM pipeline upstream of receive. Standing gate; run after any change near the shadow-map cast pass, the cast command list, or `ShadowMap`/`WebGPUShadowMap` dispatch plumbing. |
| `probe-csm-globe-receive-trace.mjs` | **Globe-terrain CSM receive trace (Batch 298, NEW-CSM-GLOBE-RECEIVE-PROJECTION-MISS).** Localizes WHY the globe-terrain CSM receiver fails to darken under a caster's shadow while the appearance-primitive receiver self-shadows fine — root-caused the cascade light-eye being on the wrong side of the projection. Use when a globe receiver doesn't darken but primitives do. (Far-edge cascade sharpness remains tracked under NEW-CSM-CASCADE-GROUND-FIT.) |
| `probe-csm-soft-shadow.mjs` | **PCF soft-shadow gate (Batch 289, NEW-CSM-SOFT-SHADOW-PCF; umbra guard repaired Batch 861+).** Validates the WebGPU cascaded-shadow-map receive path softens the cascade edge with a 3×3 PCF box kernel, matching WebGL's softness. Three cells: A = WebGPU CSM soft OFF, B = WebGPU CSM soft ON, C = WebGL single map soft ON (the reference). Run after touching the receive-side WGSL PCF kernel or the shadow sampler. **The shadow-presence floor is now WEBGL-RELATIVE, landing the fix Batch 849 stated and never applied** ("CSM ratio 0.88 versus single-map ratio 0.031, a 32x deficit that sat under that probe's ABSOLUTE `umbraPx > 200` floor and shipped green for weeks. That floor should become a WebGL-relative ratio."). `A.umbraPx / C.umbraPx` and `B.umbraPx / C.umbraPx` must both land in **[0.25, 4.0]** — the same band and rationale the probe already accepted for penumbra density — which admits the healthy 0.88 with ~4.5x margin and rejects 0.031 by ~8x. The absolute `> 200` floors are RETAINED as additional conjuncts; nothing was widened. **Exit codes: 0 PASS \| 1 real product FAIL \| 2 watchdog or exception \| 3 STRUCTURAL** — the reference cell C having no shadow of its own (`umbraPx <= 200`) leaves the ratios unanchored, which is an instrument/scene problem and must not be scored as a WebGPU defect. Report: `output/csm-soft-shadow-report.json` (now carries `umbraRatioA/B`, `umbraParityA/B`, `referenceHasShadow`, `structural`). |
| `probe-contact-shadows.mjs` | **Contact-shadow gate (Slice 5c-B, Batch 133).** Extruded "wall" polygon over Pittsburgh terrain at a low sun angle; with contact shadows enabled the wall's base casts a short grounded shadow. Run after touching the contact-shadow pass. |
| `probe-globe-effects-handle-toggle.mjs` | **Globe per-view prepared-effects-handle toggle oracle (C9-13, NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE).** Off-gate for the per-(context,frame) memoized globe group-3 effects bind group (`WebGPUGlobeSurfaceRenderer._getOrCreateFrameEffectsBindGroup`). Toggles `globe.clippingPlanes` length 1→0→1 (add plane / `removeAll` / re-add) to drive the memo's active→placeholder→active transition and asserts: (A) clipping ON changes the terrain vs baseline, (B) OFF restores the baseline exactly (no stale clipped hole = memo swapped to placeholder), (C) RESTORE reproduces ON exactly (memo re-armed, not frozen placeholder), (D) 0 errors. Run after touching the globe effects memo, its validity tuple, or `createEffectsBindGroup`. `PROBE_BASE` default :8080. |
| `probe-ellipsoid-rte.mjs` | **Ellipsoid-aware CSM ground-clamp gate (PARITY-RTE-ELLIPSOID-AWARE / FEAT-3DT2-03).** Synthesizes a 0.5×-scaled-ellipsoid globe (no Mars/Moon asset needed) and asserts the CSM `computeVisibleGroundFar` / cascade-split ground positions match the `IntersectionTests.rayEllipsoid` reference on the ACTUAL scene ellipsoid, plus a WebGL-vs-WebGPU umbra-mask IoU on the cast shadow. `--save-baseline` captures the WGS84 off-gate reference (pixel + FP-exact groundFar/splits byte-identity). Run after touching the CSM ground-clamp, `setEllipsoid` threading, or non-WGS84 scene plumbing. |

### Environment / sky / sun / atmosphere

> **C12-29 S5/S6 current-state overlay (2026-07-28, supersedes older
> counts and in-flight architecture descriptions below):**
>
> - Focused executable gates are now S6 **51/51**, S5 RTE **18/18**, S5
>   visual-source **4/4**, and dynamic-environment recovery **7/7**. The
>   protected Node set is **145/145** and the core C12-29 set is **134/134**.
>   The focused Edge/Karma dynamic-environment manager gate is **11/11**.
> - S5 state is owned by the logical `View`. CPU f64 prepares a
>   camera-independent Sun common ray plus Moon-minus-Sun differential. Terrain
>   coverage is two-stage: a provider-wide O(1) conservative envelope rejects
>   ordinary frames first; only a globally possible shadow scans selected,
>   skirt-inclusive rendered-mesh spheres. Scene prepares S1/S2/S6 and clears
>   the S5 alias/memo; retained capture, main globe, and pick each prepare S5
>   once against their exact owned selection before commands. This removes one
>   duplicate O(1) broad test per rendered-globe logical `View`/frame and the
>   repeated fit on active intersecting frames. It is a bounded eclipse-path CPU
>   cleanup, not an FPS
>   claim.
> - Custom-ellipsoid sky orientation uses geodetic up. The `StarField` altitude
>   bound follows the active ellipsoid's `maximumRadius`, but remains one
>   scalar/radial radius; do not describe it as a fully triaxial horizon model.
> - Dynamic-environment recovery distinguishes `FAILED`, `SKY_ONLY`,
>   `SUBMITTED`, and `PARTIAL`. A terrain/imagery content epoch invalidates
>   stable-provider publications, zero-draw replay neither allocates capture
>   depth/encoder resources nor records success, and repeated per-tile
>   publication calls take an exact same-frame identity/content fast return.
>
> These are focused source, Node, and current-device Edge results. They do
> **not** certify the broader NASA/real-terrain/pick-capture/dense-timing/
> custom-ellipsoid/multi-View matrix or the replacement-device browser lane.
> Preserve the longer rows below as the investigation record, but use this
> overlay when their earlier test counts or interim ownership/bounds language
> disagrees.

> **C12-29 S6 final-architecture correction (2026-07-26):** the long
> `probe-eclipse-sky-totality.mjs` row below records several in-flight repair
> iterations. Its final implementation has FOUR lanes (D/A/B/C) and 51
> companion Node tests. Lane B4 counts the star command's publication routes
> directly; it no longer infers a double draw from a sparse pixel ratio. Lane D
> boots offline, requires a rendered globe tile plus atmosphere
> ready/visibility state, and checks the constructor-default opaque-shell
> premise directly; sprite/cubemap census equality is no longer treated as a
> structural law.
>
> Current command ownership is return-only for the WebGPU star field, sky
> atmosphere, and sun. Their feature renderers return cached commands to
> `Scene`, which applies visibility and places them in the shared environment
> order; none of those renderers pushes a second command-list copy. Batch 761's
> `EnvironmentFrustumDemand` predicate supplies the sky-only frustum
> guarantee. The WebGPU sun's quad buffer, bind group, and draw command remain
> stable across clock ticks; only its uniform payload is rewritten unless an
> actual bake/pipeline invalidator changes.
>
> The two background commands are canonicalized **in place** by
> `prependUniqueEnvironmentCommands`. An already-canonical active range
> returns immediately; otherwise one stable compaction removes every legacy or
> repeated identity before `skyBox -> starField` is prepended once. The hot
> path allocates no temporary array or closure and is idempotent when the same
> frustum list is executed again. This protects repeated execution and future
> stereo plumbing from duplicate background draws; it does **not** make WebGPU
> stereo supported. `supportsStereoViewport` remains false because the WebGPU
> renderer still ignores the per-eye `passState.viewport`.
>
> "Same task" applies to rendering and reading the **live GPU canvas**:
> `captureNow()` renders and synchronously freezes PNG bytes before yielding.
> Decoding those immutable bytes to `ImageData` is intentionally asynchronous.
> The shared Acorn validator rejects unawaited direct calls, statically named
> aliases, and floating `Promise.all`/`.then` chains; `settleThen` also rechecks
> readiness after its final animation frame before capturing.
>
> Star-map effects are explicitly scoped: only the `CubeMapPanorama` created by
> `SkyBox` opts into `isStarMap`; generic and Street View panoramas retain
> identity for both brightness modulation and cloud attenuation. Scene computes
> brightness after current-frame `Moon.update`, passes ellipsoidal camera
> height, and both cubemap and catalogue paths use the same continuous
> 60–111 km atmospheric-column law (no 100 km catalogue step).
>
> **Final `probe-eclipse-scene-dimming` contract (2026-07-26):** both the
> derivation and measurement pages boot with `offline=true`. Readiness requires
> non-empty `tilesToRender` **and** a non-vacuous terrain contribution control:
> the same ground mask is rendered with white and black `globe.baseColor`, and
> a thresholded pixel-difference mask must respond before any ground dimming
> claim is accepted. State such as `skyBrightness` is frozen immediately after
> the matching render, never read after the later auto-exposure render. S6's
> horizon twilight is disabled only for the S2 manual-equivalence twin and is
> restored immediately; `probe-eclipse-sky-totality` continues to certify the
> shipped default-on horizon effect independently. The fresh WebGL + WebGPU run
> is PASS with no console errors. WebGPU's terrain control responded over
> 100% of the mask (`responsiveFraction = 1.0`,
> `meanAbsoluteResponse = 0.3388469`), so the ground lane is measured rather
> than inferred from tile bookkeeping.

> **Current S6 static count:** `eclipse-sky-totality.spec.mjs` is 51/51. That
> executable count supersedes the historical 24-test count in the long-form
> campaign narrative below.

> **`sky-brightness-twilight.spec.mjs` — C12-34, the sky-brightness estimator's
> twilight range (2026-08-02, 27/27).** `node --test
> Tools/visual-regression/sky-brightness-twilight.spec.mjs`. Pure Node, no
> browser: it EXECUTES `Scene/SkyBrightness.js` and (through
> `lib/engine-ts-resolver.mjs`) `Scene/StarFieldMath.ts`, rather than
> re-implementing either. Owns the C12-34 log-luminance model — the published
> zenith twilight-photometry ladder (μ 8 at sunset, 14 at −6°, 19.7 at −12°,
> 21.9 at −18°), the NELM perceptual transfer, the moon's `p^3.64` phase-flux
> law, and the shared `computeCelestialElevationSine` single home that C15's
> aurora night-gate will reuse. **Every metric is banded or pointwise, never a
> sweep average** — the defect it guards is invisible to an aggregate, because
> the pre-C12-34 estimator was bit-identical to the shipped one at BOTH ends of
> the range (deep night and full day) and differed only in the middle. Five
> MUTATION tests feed the checks a deliberately broken estimator (the exact
> legacy double-smoothstep, a binary day/night gate, a 1e-6 epsilon floor, a
> linear moon phase, and a re-inlined second elevation derivation) and require
> each check to REJECT it, so a green run is evidence rather than silence. Also
> pins the byte-neutral identities as `assert.equal`: deep night is exactly 0,
> a saturated day exactly 1, above the 111 km shell exactly 0, a new moon
> exactly nothing, and the S2 high-sun totality product exactly
> `ECLIPSE_TWILIGHT_FLOOR`. Run it after touching `SkyBrightness.js`,
> `StarFieldMath.ts`'s modulation block, or the `STAR_MODULATION_*` pair.
> Its companion Edge acceptance HAS since run — `probe-sky-twilight-range.mjs`
> (Batch 824), described in the next block.

> **`probe-sky-twilight-range.mjs` — C12-34 Edge acceptance for the twilight
> range (2026-08-06 / Batch 824). ENGINE + CONTROL legs PASS; PIXELS leg reports
> STRUCTURAL.** `node Tools/visual-regression/probe-sky-twilight-range.mjs`.
> Three legs, and they are graded separately on purpose:
>
> - **ENGINE** — imports the SHIPPED `Scene/SkyBrightness.js` from the served
>   source tree (never a re-implementation) and drives it at clock-SOLVED solar
>   elevations, then compares against the Batch-823 derivation. It reproduces
>   EXACTLY to six decimals on BOTH backends: −20° 1.000000, −15° 0.604705,
>   −9° 0.098257, −3° 0.006619, `webgl == webgpu` bit-for-bit, 0
>   console/device errors. **This leg is the acceptance claim for C12-34.**
> - **CONTROL** — the −20° byte-identical end, which must stay exactly
>   1.000000 because the re-derivation is only allowed to move the middle of the
>   range.
> - **PIXELS** — reported STRUCTURAL at Batch 824. **That STRUCTURAL was an
>   INSTRUMENT defect, root-caused and repaired 2026-08-07 (see the next
>   paragraph); do not carry the Batch-824 `starPx` numbers forward.** A leg that
>   cannot see its own subject must say so — and it must not be able to say so
>   for a reason that is really the probe's own render call.
> - **RENDER-TIME** (new, 2026-08-07) — reads `uniformState.sunDirectionWC` back
>   out of the FINAL rendered frame, in the same task as the capture, and
>   requires each lane's rendered solar elevation to land within 1.0° of the
>   elevation its clock was solved for AND the four lanes to be at least 2.0°
>   apart. This is the guard that makes the wall-clock class non-recurrent.
>
> **⚠ THE PIXELS LEG RENDERED AT THE WALL CLOCK until 2026-08-07, and the Batch
> 824/860 landing text claimed the opposite.** `useDefaultRenderLoop = false`
> kills `CesiumWidget.render()`, the only caller that passes `clock.tick()` into
> `Scene.render`; every render in the file was then a bare `s.render()`, which
> `Scene.js` answers with `JulianDate.now()`. So the four clock-SOLVED lanes were
> all DRAWN at the wall clock while the ENGINE leg evaluated the solved instants
> — the two legs described different scenes, which is exactly the defect the
> commit body said it had fixed. The commit ran at ~08:31 local solar time at the
> probe's site, i.e. full daylight, which is why the star field "drew nothing".
> **Every render now passes `viewer.clock.currentTime`**, the capture is same-task
> (`renderAndGrab`), and the RENDER-TIME leg above falsifies a recurrence.
>
> **★ 2026-08-07 (CO-3) — THE PIXELS LEG'S REACHABILITY CONTROL WAS RE-SCOPED
> FOR DR-01.** It used to be a FITTED COUNT (`starAddedPixels[darkest] >= 50` on
> both backends), calibrated when the shipped cube map was the UN-blurred
> `TYCHO_T5` bake. Since Batch 833 the cube map carries diffuse light only and
> the sprite catalogue is the whole resolved-star signal, so a 50-pixel floor
> over this framing sits right on top of the expected value — a coin flip, not a
> control. Following Batch 848's re-scope of `probe-stars-catalog.mjs`, it is now
> **POSITIONAL and ZERO-BARRED**: the control lane must resolve a point source AT
> the projected position of the brightest in-frame catalogue star (shipped
> `BrightStarCatalog` imported from the served source tree; the shared
> `pointSourceCensus` at its UNCHANGED `minPeak: 40` / `minContrast: 24`; 3 px
> tolerance), on BOTH backends, plus `starAddedPixels > 0`. An 81×81 box around
> the target is shipped out of the page so the detector runs in Node — the probe
> does not re-implement the census. **The `a − b > 24` difference bar is NOT
> loosened**: it feeds the MONOTONIC-ORDERING claim, not a census, and lowering
> it would admit dither. A new **STAR REACHABILITY** line prints the target's
> vmag, the census count and the nearest-source distance so a structural exit is
> diagnosable rather than merely reported. **Edge acceptance is OWED — this probe
> has not run since either the Batch-869 wall-clock repair or this re-scope.**
>
> **Exit codes: 0 PASS | 1 FAIL | 3 STRUCTURAL** (changed 2026-08-07 — the
> structural pixel leg used to exit 0 on the stated grounds that the ENGINE leg
> is the acceptance claim; that remains true and is unweakened, but an exit 0
> cannot distinguish "both legs certified" from "one leg measured nothing", and
> this probe's own history is the case for the distinction).
>
> Four orchestrator instrument defects are recorded on the C12-34 queue row
> rather than here, but the first is worth repeating because it presented
> exactly like a shipped feature that never took effect: **the module's
> signature is POSITIONAL**, and an object-literal call trips its documented
> misconfigured-scene guard and returns a uniform 1.000000 on every lane. Also:
> do not compare sky BRIGHTNESS against STAR-MODULATION predictions, and do not
> synthesize a sun for one leg while the renderer draws with the clock's — both
> produce confident nonsense. Run it after touching `SkyBrightness.js` or the
> star-modulation chain; see the C12-34 row in
> `QUEUE_2026-07-19_CAMPAIGN12.md` for the pinned-clock elevation lanes.

> **`vector-layer-draping.spec.mjs` — C11-213 / UP144-VECTOR-LAYER-WGSL,
> terrain-draped vector polylines on WebGPU (2026-08-06, 21/21).** `node --test
> Tools/visual-regression/vector-layer-draping.spec.mjs`. Pure Node, no device.
> Bakes a real tile through `VectorPipeline.packPolylineGrid`, packs it with the
> real `WebGPUVectorTileResources.packVectorTileWords`, then runs TWO evaluators
> over a 24×24 UV raster: an ORACLE transcribed from `VectorCommon.glsl` reading
> the raw `VectorTileData` tables (with the power-of-two texel addressing
> `vectorIndexToUv` + `texelFetch` imply), and a SUBJECT transcribed from
> `GlobeTerrain.wgsl` reading the packed buffer, with every header word index
> extracted FROM the shader source so the pair cannot drift with the spec green.
> Agreement is the operational meaning of "the WGSL twin matches the GLSL".
> Five MUTATION tests must each be DETECTED: no WebGPU vector path at all (the
> original defect), a bake that ignores the backend, BGRA colour packing against
> `unpack4x8unorm`, cell start read as `cellEnd[i]` instead of `cellEnd[i-1]`,
> and a dropped segment→primitive indirection. Also pins the group-2 binding-11
> storage buffer across WGSL + `WebGPUGlobeSurfaceLayouts.ts` +
> `WebGPUGlobeSurfaceRenderer.ts`, that `GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES`
> is still 12 (five sampled textures would break default-limit adapters), that
> the derivatives are hoisted to fragment entry (WGSL forbids them under the
> non-uniform storage-buffer gate — naga is what proves it), that the composite
> sits between UNDERGROUND_COLOR and TRANSLUCENT on BOTH backends, and that
> `Core/VectorPipeline.js` routes through the feature-renderer registry rather
> than an `isWebGPU` test. Run it after touching `VectorCommon.glsl`,
> `GlobeTerrain.wgsl`'s vector block, `VectorPipeline.js`, or
> `WebGPUVectorTileResources.ts` — those four are a single matched set (see
> `SHADER_PAIRS_LOCKSTEP.md`). **Its companion browser acceptance now EXISTS and
> has RUN — `probe-vector-draping.mjs` (Batch 830), described in the next block.
> The row is still not COMPLETE.**

> **`probe-vector-draping.mjs` — C11-213 browser acceptance for terrain-draped
> vector polylines (Batch 830; run at Batches 831 and 835).** `node
> Tools/visual-regression/probe-vector-draping.mjs` (`--update-baseline` records
> the non-regression reference). Edge, both backends, offline ellipsoid globe by
> default (`PROBE_TERRAIN=world` attaches Cesium World Terrain; the drape bake is
> per surface tile and independent of terrain heights, so the storage-buffer path
> is exercised either way and the frames stay deterministic enough for the
> byte-identity leg). The CPU spec proves the ARITHMETIC; this probe is the only
> thing that can show the packed buffer is BOUND, that the storage read reaches a
> real fragment, and that the composite survives tile churn.
>
> **Scene design is the evidence, not decoration.** Two `BufferPolylineCollection`
> primitives 90 km apart — pure RED width 4 px at lon −105.0, pure BLUE width
> 16 px at lon −104.0 — make two silent defect classes observable in pixels: a
> BGRA flip renders the THIN line blue and INVERTS the blue:red changed-pixel
> ratio (a colour-only check would still see "one red, one blue" and pass), and a
> dropped segment→primitive indirection collapses both lines onto one colour
> class. Meridional lines render vertically under a north-facing camera, so a
> per-row horizontal run IS the perpendicular screen width — which is what makes
> the Jacobian gate a single scalar.
>
> Six gates: **A BACKEND** (a silent WebGL fallback HARD-fails rather than quietly
> passing), **B PLACEMENT** (centroid **and bbox and** count across backends — a
> blank WebGPU pane is the pre-fix symptom), **C MATERIAL**, **D JACOBIAN**
> (far/near perpendicular width under a 10° grazing view — a hoisted-derivative
> regression shows up HERE, not head-on), **E CLEAN** (destroyed-buffer after 3
> pan-churn cycles), **F NON-REGRESS**. Readiness is binned `Pass.GLOBE` commands
> reaching `frustumCommandsList` plus a WALL-CLOCK settle budget, never a frame
> count (a cold globe pipeline variant measured ~2674 ms to compile).
>
> **STRUCTURAL conditions (exit 3, never FAIL and never PASS):** if the WebGL
> reference lane itself draped nothing, gates B/C/D are measuring an empty frame —
> scoring that FAIL files a phantom defect against WebGPU and scoring it PASS is a
> false green. Gate F is structural today: its in-build half measures 0 changed px,
> but its cross-build half needs a baseline recorded on a pre-change build, which
> does not exist. **Exit codes: 0 = every gate decided and passed, 1 = a real
> product FAIL, 2 = watchdog (420 s) or exception, 3 = no FAIL but a gate had no
> subject — acceptance INCOMPLETE, deliberately not 0 so a structural run can
> never be mistaken for green.**
>
> **What it has found.** Run 1 (Batch 831) verified draping on WebGPU and caught a
> real WebGPU-only artifact that the count and centroid legs both MISSED — faint
> horizontal streaks moved the changed count 1.4% and the centroid not at all, but
> widened the nadir bbox from x 451..710 to 252..863. That is why bbox is gated as
> a third statistic. Root cause (Batch 834): a singular UV Jacobian inverted to the
> ZERO matrix on terrain skirts — see the `NEW-WEBGPU-VECTOR-DRAPING-HORIZONTAL-STREAKS`
> entry in `DEFERRED_WORK.md` and the matching `WEBGPU_DEBUGGING_LOG.md` entry. Run 2
> (Batch 835) verified the fix at pixels (A/C/D/E pass; RED count exactly 5625 on
> both backends; centroid delta 0.0/0.0; oblique bboxes identical) and gate B now
> fails in the OPPOSITE direction on a pre-existing WebGL-side extent
> (`NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`, LOW). **The bbox predicate is
> symmetric and must NOT be flipped to a one-sided test just because the reference
> backend is the wider one now.**

> **C12-29 S5 current gate and remaining executor work (2026-07-28):**
> `node --test Tools/visual-regression/eclipse-globe-umbra-rte.spec.mjs`
> passes **18/18**. The visual-source contract is **4/4**, the protected
> eclipse/recovery set is **145/145**, the core set is **134/134**, recovery is
> **7/7**, the performance contract is **23/23**, the
> focused Edge/Karma dynamic-environment-manager lane is **11/11**, and
> `npx gulp build` plus targeted engine ESLint pass. The earlier terrain-mesh
> classification lane passed **4/4**; its requested current-tree rerun was
> blocked before browser launch by the executor approval cap, not by a test
> failure. The gate covers the direct-position f32/f64
> common ray, exact local support reject, WGS84/custom-ellipsoid ray horizon,
> elevated/fill terrain bounds, packed WebGL carrier, static inactive/active
> WebGL variant, allocation-epoch WebGPU UBO memo, pick rebinding, private
> capture upload ordering, and device-generation teardown.
>
> `node Tools/visual-regression/probe-eclipse-globe-shadow.mjs` now passes both
> backends at the derived eclipse and control instants. WebGL changed 292,507
> visible pixels with 101,378 strongly darkened and a 10.299 mean luminance
> drop; WebGPU changed 287,093 / 99,501 / 10.120. Cross-backend changed-coverage,
> strong-core, mean-drop, and footprint-edge deltas are 0.00747, 0.00259,
> 0.01741, and 3 px; both controls report zero changed pixels. This is the
> required same-task live-canvas proof, not a command-count inference.
>
> The same report now carries a fixed-camera selected-terrain lane. The outside
> target has 81/81 globe rays and exactly 36 stable skirted meshes on both
> renderers, gate 3, and zero body inverse ranges. Its S2-only capture is a
> non-vacuous darker negative control; correction returns to identity exactly
> on WebGL and within one code value on WebGPU. The first inside frame is gate
> 2 and settles at 25 meshes. The reverse first frame exposes two conservative
> root fallbacks and remains gate 2, then settles to the exact 36-mesh gate-3
> state. WebGPU correction and local each add exactly one allocation over gate
> 0, independent of tile count. Read
> `Tools/visual-regression/output/eclipse-globe-shadow-report.json`.
>
> Gates 3/4 are active correction carriers. WebGPU uses one memoized 64-byte
> View slice; WebGL uses the active bit-33 shader and packed `mat4`. Zero body
> ranges bypass common-ray, ellipsoid-horizon, overlap, and limb-fit ALU; the
> carrier must never grow per tile/pass.
>
> For WebGL compile stalls, run the same moving route with
> `run-performance-campaign.mjs --api-instrumentation --no-gpu-timestamps`.
> The event lane resets at the measurement boundary and records program
> creation, shader source, compile/link submission, `LINK_STATUS`, and first
> use. Before the static S5 variant, all seven long tasks contained exactly one
> blocking `LINK_STATUS` query (108-138.2 ms; 889.9 ms of 981 ms total long-task
> time). With the inactive/active variant, the seven waits total 753.9 ms and
> long tasks total 845 ms at the same measured 55.56 Hz refresh. That one-run
> directional result justifies the variant but is not a full benchmark claim.
> A six-pair counterbalanced current-build moving-camera lane now passes all 12
> executions and certifies renderer parity; because the banked pre-spatial
> baseline has only one run per lane, it does not prove a stable before/after
> speedup or isolated S5 cost. Final certification still requires a controlled
> active/inactive S5 cost comparison, real
> terrain/exaggeration/fill/provider, behavioral pick/capture, dense timing,
> custom-ellipsoid runtime, generic multi-View/stereo, and the NASA-SVS
> footprint with projection/clock/terrain-mask provenance. A genuine
> replacement-device run also remains; `GPUDevice.destroy()` is terminal and
> is not replacement evidence. Ordinary WebGPU remains required to show zero
> S5 ring allocation/upload; an active prepared View/block revision may
> allocate one memoized 64-byte slice reused across its commands, never one per
> tile/pass.
>
> **WebGL asynchronous-shader current-state overlay (2026-07-28; supersedes
> only the renderer-lifecycle conclusion above).** Shader-cache creation is
> still lazy and does **not** schedule work automatically. A caller must
> explicitly opt in by scheduling either an exact final `ShaderProgram` or an
> idle preparation callback. `ShaderCache` keeps required compilation and
> speculative preparation in separate queues; it runs preparation only when
> there is no active required program and the foreground compilation queue is
> empty. The globe scheduler chooses the camera-visible executable in actual
> derivation order—log depth, then HDR, then shadow receive—rather than warming
> a base program that the draw will not bind.
>
> With `KHR_parallel_shader_compile`, link submission deliberately avoids
> `LINK_STATUS` and readiness polls only `COMPLETION_STATUS_KHR`. Reflection
> and the ordinary link-status validation happen once completion is reported.
> An unexpected first bind or reflection getter synchronously completes the
> program, so direct camera scrubs cannot skip a draw or bind a wrong program.
> Browsers without the extension, runs without idle time, and excluded command
> families retain Cesium's synchronous lazy correctness path.
>
> The only speculative globe expansion accepted after measurement is one
> opposite-FOG companion for the bounded zero- and one-imagery-texture cohorts.
> It is disabled for shadow-active commands and is not applied to translucent/
> OIT, debug, pick, depth, or greater-than-one-texture variants. Persistent
> `frameState.fog.configuredEnabled` records the public configuration, while
> per-frame `frameState.fog.enabled` records whether fog is renderable at the
> current camera. The companion reads the configured value so an orbit frame
> can prepare the fog-on executable before descent even though height has made
> the current frame's `fog.enabled` false.
>
> The rejected eager experiment is an important negative control. Scheduling
> every cache-created base and derived program linked 28 programs/56 shaders,
> kept the same seven required first-use waits, and produced 21 programs that
> completed but were never needed. The accepted policy is therefore explicit
> final-program scheduling plus the single bounded fog companion:
>
> | Policy | Programs / shaders | Draw/use outcome | Blocking `LINK_STATUS` | Async completions | Long tasks |
> | --- | ---: | --- | ---: | ---: | ---: |
> | Lazy baseline | 7 / 14 | 7 demand-created programs | 7 / 753.9 ms | 0 | 7 |
> | Rejected eager scheduling | 28 / 56 | 7 required + 21 unused | 7 | 21 unused | 7 |
> | Accepted final policy | 8 / 16 | 7 drawn + 1 unused companion | 4 / 435.1 ms | 4 | 4 |
>
> Program replacement also follows acquire-before-release ownership. Releasing
> a displaced globe variant destroys it, clears the shared wrapper's
> `shaderProgram`, and recursively unschedules its derived tree; a stale culled
> tile therefore cannot fast-return a released executable. Instrumented runs
> must inspect `firstDrawProgram` (the first real draw, not merely
> `useProgram`) together with `globeShaderRequests` (camera height, configured
> and renderable fog state, texture cohort, exact fog choice, companion gate,
> log-depth/HDR/shadow state, and queue counts).
>
> The clean final r3 moving route passes with 1,175 measured frames, CPU p95
> 7.43 ms, CPU p99 10.152 ms, and four long tasks (502 ms total; 139 ms max).
> The current nine-waypoint WebGL/WebGPU/diff set also passes visual inspection
> with scene functionality intact. Four structural first-use stalls remain,
> corresponding to the first encounters of the quantization × zero/one-texture
> cohorts. Shadow-active, translucent/OIT, debug/pick/depth, and
> greater-than-one-imagery-texture variants remain excluded until separately
> measured; do not describe this targeted result as renderer-wide compile-stall
> elimination.
>
> The logical-view move also changes what a protected source assertion should
> look for: S1/S2/S6 outputs are assigned first to `view._eclipse*` and
> published as transient `FrameState` aliases inside
> `prepareLogicalViewEclipse()`. S5 is cleared there and published only by the
> exact capture/main/pick owner. The S6 assertion follows that ownership
> without weakening the factor or ordering checks. The four core
> C12-29 Node files are **134/134**; the protected visual/recovery set is
> **145/145**.

| Probe | What it covers |
| --- | --- |
| `cloud-reconstruction-attachments.spec.mjs` (`node --test`, no browser) | **C13-09 reconstruction attachment topology (CO-23, 2026-08-07, 40 tests).** Executes the REAL contract table, the REAL generation lifecycle and the REAL depth estimator — nothing here is a re-implementation. Groups: **A** the four-slot contract (slot 0 is the EXISTING half-res march target and must stay `ownedHere: false`; depth `rg32float` with front AND weighted channels; velocity `rgba16float` because two channels cannot say "could not reproject"; normalized moments because raw metre-squared moments saturate half-float; per-attachment clears, with `-1` the no-cloud sentinel and every other clear non-negative; **the owned `consumers` lists must be EMPTY**, which is the row's honest state). **B** lifecycle over create / resize / DEVICE SWAP (keyed on `GPUDevice` identity, not size) / release, including the MONOTONIC-generation property C13-40's retirement work depends on — a release that rewinds the counter fails here. **C** the estimator over its whole domain: inside the interval, monotone in alpha, translation-invariant, midpoint at alpha 0, near-front at alpha 1, and NO snap discontinuity. **D** uniform packing offsets, the 56-float block cross-checked against the WGSL struct's own `mat4x4`/`vec4` count, and stale-matrix zeroing. **E** renderer wiring with mutants: DEFAULT OFF, producer encoded between the march and the resolve, **THE COMPOSITE UNCHANGED** (the only reassignment of the upscale source is still the temporal history, and the resolve/upscale shaders contain no attachment sampler), self-healing release, culled-frame flag reset, and the counter writes. **F** the C13-39 constraint enforced MECHANICALLY: `ProceduralClouds.wgsl` pinned by SHA-256 and line count, the producer required not to embed the march, and the producer pipeline required to compile from its own module ALONE. **G** naga on the producer and on the untouched march. **If F1 fails and you are C13-10**, that is expected — C13-10 is the row permitted to change the march and updates the pin in the same commit; **if F1 fails and you are anyone else**, the change belongs in a separate module and pipeline. |
| `probe-fleet-contract.spec.mjs` (`node --test`, no browser) | **AUTHORING-TIME enforcement of the probe machine-safety contract (batch CO-20, 2026-08-07; extended by `C18-V1`, 47 tests).** Scans every `Tools/visual-regression/probe-*.mjs` for (a) a watchdog — a `setTimeout` whose callback terminates the process, (b) `browser.close()` inside a `finally`, (c) that a probe declaring the 0/1/2/3 contract never routes STRUCTURAL to exit 2, (d) **that a probe printing a PASS/FAIL verdict can leave with a non-zero exit code** — fleet-wide, NO allowlist, because a probe that prints `GATE FAIL` and exits 0 is recorded as GREEN by anything scoring runs by exit status, and (e) that the analyzer's own scanner reaches the end of every probe still reading code. Rule (d) is position-aware: a non-zero exit must be reachable FROM the last FAIL print (an exit call below it, or a `process.exitCode` assignment, which applies wherever it sits), so an `exit(2)` on an early fatal branch does not certify a verdict printed after it. It fires only on sources that print BOTH outcomes — a per-item `LOAD-FAIL` status column on a diagnostic dump is not a verdict and is not required to carry a code, which is what keeps the rule from silently pushing exit-code adoption. Rule (e) exists because the scanner USED to go blind: a regex literal may carry an unpaired quote (`/Destroyed texture \[Texture "GlobeDepth-DepthCopy/`), reading it as a string opener blanked every construct below it, and that is why the manual sweep that filed this class counted 3 probes when there were 15. **A NEW probe missing the constructs FAILS this spec** — that is the gap it exists to close: the 2026-08-07 machine-safety sweep found 11 of 34 recent probes with no watchdog, and filed its own residual as "the sweep was manual, so the next batch of probes can reintroduce it." Census at `557445c2a0`: 620 probes, 615 launch a browser, **55 compliant, 560 in `lib/probe-fleet-contract-allowlist.mjs`** with a one-line reason each naming the missing construct and the probe's add-date. **The allowlist is a RATCHET, not an escape hatch:** the spec fails on an entry whose file is gone AND on an entry whose probe now complies, so repairing a probe requires deleting its row in the same change and the list can only shrink. Do NOT add to it. **Priority when triaging:** Playwright reaps the browser on process exit, so a missing `finally` matters only on the throw path — **the watchdog is the load-bearing half** and is the only construct that ends a hung probe. Two MUTATION controls strip the watchdog (and separately the `finally`) out of a copy of a currently-compliant probe's source and require the violation to reappear, because the fleet assertions pass trivially if the analyzer stops detecting. The analyzer (`lib/probe-fleet-contract.mjs`) blanks comments and string literals length-preservingly before any scan — several probes print the words "watchdog" and "STRUCTURAL" from their exception handler — and resolves an exit's controlling `if` by CONTAINMENT rather than a lookback window. Exit-3 detection accepts all four spellings the fleet uses (`exit(3)`, `EXIT_CODE.STRUCTURAL`, a structural-guarded `return 3`, a `laneBlind ? 3 :` fold) and follows ONE hop into a local `./lib/*.mjs` verdict module — for the structural tier only, never for the watchdog or `finally`, which must live in the process that owns the browser. **It does NOT push exit-3 adoption** (that is the `PROBE-FLEET-EXIT3-CONTRACT-ADOPTION` maintainer ruling); its exit-3 test is an anti-regression anchor over the ten probes that already implement it. Run it after adding ANY probe. |
| `probe-env-skybox-stars.mjs` | **SkyBox star cube-map parity gate (ENV-SKYBOX-STARMAP, 2026-07-02), webgl-vs-webgpu.** Pinned-clock sky-only view (camera 50 Mm up, pitch +90° — no globe/limb/sun in frame), captures cube-map-only (`skyBox.starField.show=false`) and default per backend. Asserts: star-pixel density + mean sky luminance ratios in [0.75, 1.33]; **aligned block-luminance pattern correlation > 0.5 AND > the vertically-mirrored correlation** (catches the cube-face flipY parity bug — WebGL uploads faces with `UNPACK_FLIP_Y_WEBGL=true`, WebGPU must pass `flipY:true` to `copyExternalImageToTexture` or every face mirrors and a different sky region shows); 0 device errors. Also guards the default-off gate of the Phase 1.4 cloud-cover star occlusion (`globe.cloudCoverage` defaults 0.5 — ungated it halved the skybox). Run after touching `WebGPUCubeMapPanoramaRenderer.js`, `CubeMapPanorama.wgsl`, or the weather→star occlusion wiring. **✅ REPAIRED 2026-08-07 (was: `framingReached` vacuous, exit 0 a live false green; filed under `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` in [DEFERRED_WORK.md](DEFERRED_WORK.md)).** The old `framingReached` asserted `sunElevationDeg >= 25` — the exact predicate Batch 859 deleted from `probe-celestial-gates.mjs` — over the same `5.0e7` m camera (~43,600 km, far above `ATMOSPHERIC_COLUMN_FADE_END = 111 km`), so `frameState.skyBrightness` is identically 0 and the C11-176 star modulation the framing claimed to reach cannot occur at ANY solar elevation; it was a `pass` conjunct and the probe had no structural tier, so the scene reported a certifying green. **Now:** the proxy conjunct is GONE from `pass`; `starModulationReachable` names the DRIVING variable (`skyBrightness > 0.5` on both backends) and is REPORTED with an explicit "do not cite this run about star modulation" banner; the `sunlit` lane is relabelled **sun-aligned orbital** for what its camera genuinely certifies (default-pair cube-map + sprite parity). A **structural tier** was added on the only blindness this probe's own subject admits: the WebGL REFERENCE must have produced a signal (`starPct`/`meanLum`/`brightPct` > 0 and the correlation grids non-degenerate — `correlate` now returns `varianceA`/`varianceB`), because `rat()` returns 0 on a zero denominator and `pearson` returns 0 on a flat grid, so a reference that drew nothing would have scored as a confident FAIL. **No fitted floor is involved: the bound is zero.** **Exit codes: 0 PASS \| 1 FAIL \| 2 watchdog \| 3 STRUCTURAL.** **The cube-map parity claims above are unaffected — that IS what this probe measures. Still do not cite it as evidence about star brightness modulation, sky brightness, or anything driven by `skyBrightness`; that subject belongs to `probe-celestial-gates.mjs`'s `in-column-star-modulation` lane.** |
| `skybox-diffuse-seam.spec.mjs` (`node --test`, no browser) | **C12-11 / DR-01 star-map seam (Batch 833, 24 tests).** Standing proof that the SHIPPED bytes and the SHIPPED default keep one physical owner per celestial signal: the cube map carries diffuse Milky Way light only, the `StarField` sprite catalogue owns every resolved star. Fails if a diffuse face regains resolved point sources (the low-pass was skipped, weakened, or run on the wrong input), if a face LOSES its degree-scale band structure (the opposite failure — blacked out instead of low-passed), if the un-blurred `TYCHO_T5` reversal artifact stops being bundled or stops differing from the diffuse set, if `SkyBox.defaultVariant` drifts off the diffuse variant or a variant is registered without a descriptor (a typo there 404s the sky silently), if `skybox-manifest.json`'s recorded evidence drifts from the bytes (every SHA-256 is re-derived), or if the LICENSE.md bundled-assets entry stops covering the faces. **Why the metrics are shaped this way — the trap this spec exists to survive: a whole-face MEAN is INVARIANT UNDER BLUR, so it cannot distinguish blurred from un-blurred in either direction.** Two orthogonal metrics from `Tools/skybox-bake/starmap-census.mjs` instead: a POINT metric (strict local maxima above a LOCAL ring background) for resolved stars and a SCALE metric (spread of coarse block means) for the diffuse band, with a SYNTHETIC group against known ground truth and a MUTATION group that breaks the detector to prove teeth. Pure Node — the heavyweight pixel pass runs in the bake (which already has `sharp`) and lands in the manifest. **Landing note (REPO-TOOLING-SOURCE-ANCHOR-FRAGILITY):** its mutation targets were authored with bare `\n` and matched nothing on this CRLF checkout — the spec's own `assert.notEqual(mutated, original)` guard caught it and failed LOUDLY instead of verifying nothing. Both readers now normalize CRLF → LF. Any spec that mutates source text must assert its mutation actually changed the text. Run it after touching `Tools/skybox-bake/`, `SkyBox.js`'s variant table/default, or the bundled SkyBox assets. |
| `probe-env-moon.mjs` | **Moon disc parity gate (ENV-MOON-SLIVER, 2026-07-02), webgl-vs-webgpu.** Pinned clock (2026-07-02T16:22Z, the user's repro time), reads the moon's world position from `moon._ellipsoidPrimitive.modelMatrix`, parks the camera on the Earth→moon line 20,000 km out and aims at the disc (~190 px). Playwright-screenshot center crop per backend (in-page `drawImage` of the WebGPU canvas can grab a stale frame — the compositor screenshot is authoritative), canvas-decode metrics: lit-pixel ratio in [0.8, 1.25], luminance stddev > 6 on BOTH (textured craters, not a flat disc), disc centers within 40 px, pixel diff < 15%. Guards the model-space RTE convention in `Moon.wgsl` (`rte = posMC − camMC`; a world-space offset gets rotated by the moon's IAU orientation and throws the disc off-screen — the "white sliver" bug) and the zero-specular `Material.ImageType` parity. **Crescent-phase pass (NEW-ENV-MOON-CRESCENT-PROBE, 2026-07-03):** a second capture at ~last-quarter phase (2026-07-08T12:00Z, Simon1994 expected illuminated fraction ≈0.43) gates the B505 phase-terminator shading: partial lit fraction vs the full-disc pass in (0.15, 0.85) per backend, gpu/gl lit ratio in [0.8, 1.25], lit-pixel centroids within 25 px (terminator on the same side), pixel diff < 15%. Run after touching `Moon.wgsl`, `packEllipsoidBaseUniforms`, or `_packMoonUniforms`. |
| `probe-moon-sunlit.mjs` | **Moon "reads as sun-lit, not matte" gate (NS-MOON-MATTE-NOT-SUNLIT, 2026-07-05), both-backends-correct + webgl-vs-webgpu parity.** Premise-verification probe for the user report "the moon renders matte/flat, no sun-relative shading." Result: **premise STALE** — B505 (model-space RTE placement) + B517 (crescent terminator) already ship correct sun-relative shading on both backends. Two per-backend content gates a genuinely flat/emissive disc would fail: (1) **limb darkening** at near-full phase (2026-07-02T16:22Z) — rim-ring/center-ring luminance ratio `limbRatio < 0.6` (measured ≈0.27 both backends; a matte disc → ~1.0), proving a lit Lambert sphere; (2) **graded terminator + sun-facing lit hemisphere** at ~half phase (2026-07-08T12:00Z) — `partialFrac` (lit-area half/full) in (0.15, 0.85), lit-centroid displaced > 0.08·R toward the sunlit limb (measured ≈0.24·R), and ≥3 distinct luminance buckets across the terminator scanline (graded, not a hard step). Cross-backend center-crop pixel diff < 15% at both phases (measured 3.8% full / 0.75% half). Run after touching `Moon.wgsl`, the `czm_private_phong` / `ONLY_SUN_LIGHTING` moon path, `packEllipsoidBaseUniforms`, or `_packMoonUniforms`. |
| `probe-moon-lola-relief.mjs` | **C12-25 LOLA terminator-relief acceptance (Batch 813)** — 8 lanes: half/full phase x WebGL/WebGPU x relief ON/OFF (`atmosphericConditions.lighting.enableLunarNormalMap`), pinned clocks, camera 20,000 km short of the moon (~190 px disc), 420 px center-crop diffs. Gates: terminator ON-vs-OFF >= 0.4% both backends (measured 1.30/1.30); full-phase ON-vs-OFF **< the half-phase value AND < 3%**; cross-backend parity ON < 15%; identity (parity OFF) **<= parity ON + 1.0% noise AND < 15%** (measured 0.00/0.00); 0 errors. PNGs `moon-lola-*` show crater-serrated vs smooth terminator. Run after touching the `LUNAR_NORMAL_MAP` block in `EllipsoidFS.glsl`, the binding-3 path in `Moon.wgsl`, `_loadMoonNormalTexture`, or the bake under `Tools/moon-albedo-bake/`. **LANE 2 / LANE 4 GATE REPAIR (Batch 861+) — two of the four documented lanes were not the criteria the code enforced.** Lane 2's relative clause was written `fullGl < Math.max(3.0, halfGl) && … && fullGl < 3.0`; since `Math.max(3.0, H) >= 3.0` for every H, the later conjunct implies the first UNCONDITIONALLY, so `onOffDiffPct(full) < onOffDiffPct(half)` was never enforced anywhere — the classic absolute-floor-dissolves-a-relative-comparison trap. Lane 4 was implemented as the same absolute `< 15` as Lane 3 and never referenced `parityOn` at all. Both now enforce the documented relations. **The trigger already fired: the Batch-813 run that CERTIFIED C12-25 recorded half 1.30% and full 1.46% — full EXCEEDS half — and the probe printed GATE PASS.** The previously-recorded "measured 1.46, per design" reading above is therefore the rationalization, not the gate; on numbers of that shape **this probe now FAILS**, and that failure is the finding the row is owed. Also hardened: `Image.onload` in the crop-diff page had no `onerror` and `page.evaluate` accepts no timeout, so one undecodable PNG hung the run forever — both paths plus a 30 s in-page decode deadline are now wired, browser closes moved into `finally`, and a 900 s unref watchdog exits 2. |
| `probe-moon-texture-lifecycle-edge.mjs` | **C12-35 schema-v2 lifecycle certification (2026-08-02, real Edge 151, PASS).** Launches WebGL+WebGPU in one split-page JavaScript realm with default network imagery disabled. Proves one shared fetch/decode per exact Moon source but backend-local GPU realizations; normal strength 1→0→1 retains the real normal resources, removes WebGL binding/WebGPU demand, and causes zero cache/request/publication churn; delayed distinct B readiness wakes both request-render scenes while A remains published until frame-owned commit; delayed C is canceled by return-to-B and current/final visible crescent PNGs are byte-identical per backend; the WebGPU queue drains; delayed D begins with four live leases and Viewer destruction retires both Moon lifecycles, aborts both loads, and leaves zero active leases/pending entries. Hard gate: exact bundle provenance, exactly two B/C/D source requests each, zero console/page/GPU faults, visible pixels, and hard exit 0/1/2. Report: `output/performance/campaign12-c12-35-l5-moon-texture-lifecycle-edge.json`; sibling `current-b`/`final-b` WebGL/WebGPU PNGs. Moving seam/shimmer is deliberately owned by C12-33's mip/sampler/derivative gate, not this static lifecycle gate. Run after touching `MoonDecodedSourceCache`, either Moon texture lifecycle, `Moon.update/destroy`, WebGPU Moon publication, Scene teardown, async-resource wakeup, or WebGPU device destroy/loss handling. |
| `probe-moon-mip-motion-edge.mjs` | **C12-33 moving Moon mip/LOD/seam acceptance (implemented 2026-08-02; calibration/browser acceptance pending).** Flies four routes per backend—close, seam-centred, seam-at-limb, and minified—under paired normal and forced-LOD0 controls. The probe uses strict per-lane thresholds, unique run IDs, exact lane/pair counts, p95/CV/spatial bands, parity IoU, and a sensitivity gate proving the normal path differs from its control; malformed, missing, or empty threshold schemas fail closed. Before promotion, collect at least five paired real-Edge repetitions, populate `CALIBRATED_THRESHOLDS`, and inspect every seam PNG because summary statistics cannot certify a wrapped-longitude discontinuity. Current source is intentionally `CALIBRATION_PENDING`; do not cite it as a visual PASS until that evidence exists. Run after touching Moon samplers, explicit texture gradients, mip generation, seam unwrap, texture-view compatibility, or Moon texture publication. |
| `probe-scene-snap.mjs` | **C11-212 `Scene.snap` baseline acceptance (Batch 813, provenance contract corrected 2026-08-02)** — CesiumMilkTruck at 100 m AGL, camera 300 m out, both backends. Gate A: snap at the model returns a hit within 50 m. WebGPU polling now means “wait for a completed payload whose immutable camera/frustum/viewport provenance matches,” not “consume the previous query.” Gate B: corner snap returns no model hit. Gate C: WebGPU `context._snapEnabled` changes false→true as an ever-used diagnostic only; current command demand is `frameState.passes.snap`. Gate D: 0 console + 0 validation errors. Run after touching `WebGPUSnapFramebuffer`, `WebGPUSnapPayload`, `fragmentSnapMain`, the pick-pass payload phase, or `Snapping.js`. **Exit codes: 0 PASS \| 1 real product FAIL \| 2 watchdog or exception \| 3 STRUCTURAL (added Batch 861+).** The probe previously had only `process.exit(pass ? 0 : 1)` with no try/catch and no `.catch()` on either top-level `await run(...)`, so a missing `CesiumMilkTruck.glb`, a dev server on the wrong port, or any in-page rejection surfaced as a non-zero exit indistinguishable from "C11-212 Scene.snap acceptance FAILED" — a phantom product defect over a run in which snap was never exercised, with the Edge process left unclosed. Three preconditions now route to 3 instead: the model never reached `ready` on either backend; the WebGPU lane did not resolve `rendererType === "webgpu"` (Gate C's `_snapEnabled` latch does not exist on WebGL, so such a run certifies nothing about the WebGPU path); and any throw becomes exit 2 with its stack. Browser closes moved into `finally`; 420 s unref watchdog. The four gate thresholds are UNCHANGED. |
| `probe-snap-multifrustum.mjs` | **C11-212 real-GPU stale-payload gate (2026-08-02, GREEN on rebuilt Edge/WebGL + WebGPU).** Forces a far snappable Model and a nearer snapless Primitive into different frustum slices at the same query pixel. Requires stable far hits, stable misses after the near depth occluder appears, then stable far hits after it is hidden; this prevents one cached completion from deciding a transition. Requires ≥2 populated frustums, distinct owning slices, TAA enabled, and zero console/page/WebGPU validation errors. The accepted run has `farVisible`, `nearOccludes`, and `farReturns` true on both backends; report: `output/snap-multifrustum-report.json`, captures: `output/snap-multifrustum-{webgpu,webgl}.png`. This is the browser gate for any per-slice payload reset/erase change. |
| `webgpu-snap-edge-payload.spec.mjs` (`node --test`, no browser) | **`UP144-SNAP-WEBGPU-EDGES` / C11-212 edge tier (Batch 821, 25/25).** The Node half of the WebGPU snap EDGE payload: it stands a live stub device up, drives the real `WebGPUEdgeVisibilityEmitter` pipeline + uniform buffer, round-trips a real RG32Uint payload encode/decode (R = the repacked pick key, G = eye-depth f32 bits with the sign bit ALWAYS set, which is what makes every fragment this pipeline rasterizes an edge), runs naga in BOTH log-depth states, and lifts and EXECUTES the `Snapping.js` sample-center functions rather than regex-matching them. Six mutation tests. Pins the emitter under `NO_CENTRAL_CACHE` for `pipeline-key-aliasing.spec.mjs`. **The browser half is still OWED:** no Edge run has yet compared a real silhouette snap across backends (`isEdge: true` on both, positions inside tolerance), so C11-212 stays PARTIAL. Note the shared-path half-pixel fix that shipped with it moved WebGL's snap results too — it is NOT a WebGPU-only change. |
| `probe-moon-phase-gate.mjs` | **Moon phaseGate blackout gate (C11-176b, 2026-07-24), webgl-vs-webgpu.** Guards the DELETION of the `Moon.wgsl` whole-disc `smoothstep(0.0, 0.3, u.phaseFraction)` multiplier — a WebGPU-only physical double-count (N·L vs the real Simon1994 sun direction already yields terminator + phase) that blacked out the entire disc at small sun-moon elongations (every daytime moon near the sun; the C12-30 "dark blob"). THREE lanes, epochs **derived in-page from Simon1994** (30-day scan, 3 h steps, deterministic — no hardcoded lucky dates): `day-crescent` (phaseFraction 0.005-0.09 — old gate ≤ ~0.10, ≥ 90% blackout, the defect lane; sun > 60° high at the sub-lunar vantage so it's a genuine daytime moon), `crescent` (0.10-0.20 — old gate ~0.35-0.65 partial dimming), `night-full` (0.93-1.0 — old gate exactly 1.0, so this lane isolates the phaseGate from any second cause and must pass before AND after). Moon-disc ROI found by PROJECTING moonPositionWC + a limb point through the camera (no hardcoded pixels; fov 3° so the ~0.5° disc spans >~100 px); metrics = lit-pixel fraction of disc area + mean luminance over lit pixels; parity bands litFrac [0.7, 1.35] / meanLumLit [0.7, 1.4]; blackout detector litFracRatio < 0.3. Atmosphere/skybox/globe/sun/fog hidden → the NS-MOON extinction gate is exactly vec3(1) on both backends (the defect still reproduces: `enableMoonPhase` rode on globe EXISTENCE, not `globe.show`). All Batch-744 probe rules: default loop killed, pinned time on EVERY render, sun-dir settle loop, same-task canvas capture, canvas-element PNGs, rendererType hard-check, WebGL sanity floors (an all-black canvas cannot vacuously pass), 300 s unref watchdog, hard exit codes, **provenance hard-gate** (source `Moon.wgsl` SHA must equal the built copy AND no built bundle may contain `let phaseGate` — exit 2 on a stale build). Companion source spec `moon-phase-gate.spec.mjs` (`node --test`): comment-stripped gate-absence assertions, `var color = lit;` pin, C12-21 scaffolding intact (`phaseFraction` UB member + `ud[67]` pack + `frameState.moonPhaseFraction` publication), EllipsoidFS.glsl stays phase-term-free (parity direction), naga validation. Run both after touching `Moon.wgsl` lighting or `_packMoonUniforms`. |
| `probe-moon-atmosphere-appearance.mjs` | **Moon atmospheric appearance gate (C12 moon wave: C12-30 sky-wash + C12-20 Lommel-Seeliger + C12-23 opposition surge, 2026-07-24), both-backends-correct + webgl-vs-webgpu parity.** Guards the radiative-transfer composite `disc = disc × extinction + inscatter` (the wash comes from the CPU integral `computeAtmosphereInscatter`, which mirrors the sky shader's own scattering model) plus the LS disc law and the SHOE surge. THREE lanes; epochs **derived in-page from Simon1994 by phase window** (60-day scan, 3 h steps) and the **ground observer solved analytically** so moon/sun sit at pinned elevations (up = a·m + b·s + w·(m×ŝ) from the two sin-elevation dot constraints; feasibility + ±3.5° elevation verification are structural gates): `day-mid` (moon ~45°, sun ~40°, pf 0.12-0.40 — gates: sky present ≥25, **darkFrac < 0.15** (the dark-cutout detector: fraction of disc pixels below 0.7× the sky ring), lit peak ≥ ring+25, discMean ≥ ringMean−5), `horizon` (moon ~4°, sun ~25° — gates: lit-peak-above-sky < 0.6× the no-atmosphere control's peak, lit-pixel R/B rises > 1.05× control), `night-full` (moon ~45°, sun −25°, pf 0.88-0.95 — gates: sky ring < 8 mean with > 90% dark pixels [wash ≈ 0 at night], disc stays bright: litFrac ≥ 0.5, meanLumLit ≥ 45 and within [0.5, 1.1]× control). Each lane measures a no-atmosphere CONTROL pass then the ATMOSPHERE pass in one evaluate; cross-backend parity discMean ratio [0.7, 1.4], ring ratio [0.6, 1.6]. All Batch-744 probe rules (pinned clock on every render, settle loop, same-task capture, `locator('canvas')` element PNGs, rendererType hard-fail, sanity floors, 420 s unref watchdog, exit 0/1/2, bounded loops) + **provenance hard-gate**: source `Moon.wgsl` SHA == built copy AND the built bundle must contain `u_atmosphereInscatter`/`LUNAR_BRDF`/`oppositionSurge`/`enableMoonSkyWash` (stale-build guard). Companion source spec `moon-atmosphere-appearance.spec.mjs` (`node --test`, 14 tests): both-backend formula pins (LS `2·μ0/(μ0+μ+1e-4)` character-identical), add-only UB pins (336 B, ud[79..83]), C11-176b contract re-pins, integrator numerics (day wash blue-dominant, horizon whiter/brighter, night + orbit EXACT zero, cache identity/hit), surge curve (I(0)/I(4°) ≥ 1.4, monotone, inert at 90°), naga. Run both after touching `Moon.wgsl`, `EllipsoidFS.glsl`, `computeAtmosphereExtinction.js`, `computeLunarOppositionSurge.js`, or `_packMoonUniforms`. |
| `probe-eclipse-cloud-response.mjs` | **C13-41 (the C12-29 S3 rider) Edge acceptance — eclipse-driven CLOUD LIGHTING, CLOUD SHADOW and IBL dimming/refresh. AUTHORED 2026-08-07 (CO-9); NEVER RUN — every band is `DERIVED`, not calibrated.** The row landed at Batch 871 with three pre-registered falsifiable predictions and NO probe: the four existing eclipse probes measure none of them (CO-1 reconciliation). **(a) DECK LIGHTING** — WebGPU only. Four captures per rung at ONE pinned instant, `{eclipse off,on} x {clouds on,off}`, from a ground vantage at ANTI-SOLAR azimuth pitched +12 deg (the S1 sun billboard is out of frame, so nothing measured can be its alpha fade). The deck's own contribution is the WITHIN-POSITION difference `cloudsOn − cloudsOff`, so the sky — which S2 already dims through its own sites — cancels exactly. Gate `deckRatioInBand` against **[0.44, 0.70]**: the row states the PRE-tonemap ratio is exactly **0.4642** at obscuration 0.9 and the DISPLAYED ratio lands in [0.46, ~0.63], never above ~0.7; the lower bound is 0.4642 less a 5% relative allowance for 8-bit quantization on a difference image. Plus `deckRatioMonotone` and `factorMatchesSecondImplementation` (the published `eclipseSceneLightFactor` against a re-derivation of the S2 curve from the published 5-lux floor and 1/3 exponent — a retune of either fails here instead of riding along). **(b) CLOUD SHADOW** — WebGPU only. Looking down, `cloudCastShadows` toggled in each eclipse position; the metric is the CONTRAST `shadowOn/shadowOff`, and the CLAIM is that an eclipse leaves it essentially unchanged (**+0.08%**, `mix(1,0.35,s)` going 0.350000 → 0.350293) because an eclipse dims the direct beam and the skylight together. Gate `shadowContrastInvariant` against **[0.97, 1.03]** — two orders of magnitude wider than the predicted move and set by 8-bit noise, NOT by the effect. That band is also the **DISCRIMINATOR**: `shadowContrastRejectsAlternativeDesign` fires at a dedicated 0.5452-obscuration rung where the REJECTED design (shadow strength = S2's scene factor, the substitution the row refutes on arithmetic) puts the contrast ratio at **1.429**, 14x outside the band. `shadowStrengthMatchesDirectional` additionally pins the published `_cloudCache.shadowStrength` to `visible/(visible+FLOOR*(1−visible))` to 1e-9 — exact, cheap, and by itself sufficient to refute the alternative. **(c) IBL DIM + REFRESH CADENCE + RECOVERY** — BOTH backends (the row ships the IBL leg symmetrically). A `TestKhrSpecular` model supplies the `DynamicEnvironmentMapManager`; the globe is hidden and the punctual sun zeroed so captured pixels are pure environment ambient. An **801-frame sweep** walks obscuration `0 → 0.9 → 0` (401 real instants aimed at the linear ramp by bisecting the engine's OWN `updateEclipseState` — AIMING, never gating — then a REVERSE REPLAY for the descending branch so the factor series is an exact mirror and the count is determinate rather than a coin flip on where a real falling branch's samples land). The refresh count is read as **committed-bucket LEVEL TRANSITIONS** (`_webgpuCache.lastEclipseEnvBucket` / `manager._lastEclipseEnvBucket`) — both managers commit only inside the branch that re-fills, so one transition IS one fill. Gates: `predictedRefreshCountExact` **=== 275** (1 baseline + 2x137 edges, buckets 256 → 119; DERIVED in `lib/eclipse-cloud-response-gate.mjs`, not written down), `rampNeverSkipsABucket` (the count is CHANGES not EDGES — a coarse ramp merges edges and the count collapses; 401 frames gives 0.89 buckets/frame at the steep end, and the spec proves a 201-frame ramp DOES skip), the two engine-count bands **[234, 275]** (275 is the arithmetic ceiling — a C11-193 deferral can only merge, never create), `sweepQuiescenceInBand` **[0.60, 0.75]** (the row's "roughly two thirds"; 527/801 = 0.658), `iblDimsAtDeepest` **[0.30, 0.85]** (upper bound rejects NO response — the defect this row fixed; lower bound rejects DOUBLE application, since the SH step-3 multiply also acquiring the factor would square it to 0.2155), and **`iblRecovers` [0.98, 1.02]** — the ANTI-LATCH assertion the row explicitly still owed, stepping the clock through the deep phase and out the other side and requiring the environment to brighten back. **COST:** an identical 801-frame control leg with `enableEclipse` OFF (which produces exactly one fill) makes the wall-clock differential attributable, discharging `C13-41-ECLIPSE-REFRESH-COST-UNMEASURED` in the same run; `refreshCostMeasured` gates only that a real non-negative number came back, because there is no pre-registered budget to score it against. **WebGL gets NO cloud lane by design** — its cloud path is the billboard `CloudCollection`, whose FS has no sun direction, no scene light and no N-dot-L; that premise is a SOURCE claim pinned by `eclipse-cloud-ibl-response.spec.mjs` (E2), not re-litigated in pixels. Full pinning doctrine (`lib/weather-probe-pinning.mjs`: offline globe read back, one render driver, `cloudWindSpeed=0` so the moving clock is provably inert on cloud SHAPE, `cloudQuality=32` escape tier, discarded warm-up, same-task capture, canvas-ELEMENT PNGs, rendererType hard-fail, determinism bracket, 480 s unref watchdog — 8 min not the usual 7 because lane C renders 801 pinned frames per backend, `browser.close()` in `finally`), and the **0/1/2/3** exit contract: pin or vacuity failures exit **3** and emit NO product verdict. Companion pure spec `eclipse-cloud-response-gate.spec.mjs` (`node --test`, 36 tests) proves the fold without an adapter: it recomputes all three published numbers (0.464228 / 0.999550 / 275), shows the ramp does not skip, reconstructs the rejected design and shows the band excludes it, and drives **13 mutants** each of which must fail exactly its own named predicate — plus five vacuity cases that must go STRUCTURAL rather than emit a verdict. **Orchestrator: after the first Edge run, TIGHTEN the bands against the observed margins and flip `status` off `DERIVED`; widening one to make a run pass is the failure mode the `why` strings exist to make visible.** |
| `probe-eclipse-sun-fade.mjs` | **Eclipse / occultation continuous sun fade (C12-29 S1, 2026-07-24), both-backends-correct + toggle-off identity.** Guards `frameState.eclipseState` (limb-darkened dual-cone circle-overlap, `Scene/EclipseState.js` + `Scene/computeSolarObscuration.js`) and its first consumer, the sun billboard ALPHA multiply on BOTH backends (`SunFS.glsl` `u_eclipseAlpha` / the sun WGSL's `eclipseAlpha` in the former `_p2` pad). THREE lanes. **(a) orbital-sunset** — pinned clock, camera swept in 121 equal 0.03° elevation steps from a 400 km vantage through the Earth-limb occultation (the camera moves, not the clock, so the sweep is exactly reproducible): asserts the sun's screen-luminance envelope is CONTINUOUS (`maxStepDelta ≤ 0.20` of peak — pre-fix WebGL drops the whole glow in ONE step at the bounding-volume cull boundary, delta ≈ 1.0), MONOTONE (`maxRise ≤ 0.05`), reaches zero (`lastNorm ≤ 0.02` — pre-fix WebGPU never culls and never dims, so its glow persists forever), starts bright (`firstNorm > 0.5`, absolute floor `peak > 2000` so a black canvas cannot pass), sweeps the full physics range (fraction 1 → 0), and `sunEclipseAlpha === sunVisibleFraction` bit-for-bit. **(b) eclipse-2026** — the 2026-08-12 partial instant, epoch + ground vantage **derived in-page from Simon1994** (2 regions × 3×3 lat/lon grid × 301 minute samples, then stepped off the maximum into the 0.40–0.65 obscuration band so the linearity is measurable; the probe's own uniform-disc implementation locates the instant, the ENGINE's limb-darkened value is what is asserted): `sunVisibleFraction < 1`, the MOON is the occluder (`moonObscuration > 0.2`, `earthOcclusionFraction === 0`) with `scene.moon.show = false` (an eclipse must dim the sun whether or not the decorative moon draws), and the measured glow ratio ON/OFF tracks the fraction linearly. **(c) toggle-off** — measured IN THE SAME STEPS as lane (a), not in a second sweep. **REDESIGNED TWICE (2026-07-24); every failing check was a check-design flaw, never an engine defect.** v1's `legacyBehaviourRestored` asked the LUMINANCE metric to show WebGL's binary pop, which is geometrically unobservable — the cull can only fire once the Earth's limb already covers the glow annulus, so the metric is ≈0 in BOTH toggle positions (measured WebGL OFF `maxStepDelta` 0.03, WebGPU OFF `lastNorm` 0). v1's `byteIdenticalWhereUnoccluded` compared canvas hashes ACROSS two sweep runs, which `czm_frameNumber`-driven animation makes non-deterministic. v2 kept the two-sweep shape, and that alone broke three more things: the identity tolerance was missed (0.027 vs 0.02) because 60–78 of 121 steps ran on unsettled globe tiles whose limb pixels differ between runs; the saturation mask could not be shared across two `page.evaluate` calls, so WebGPU's additive clamp pushed its band ratio to ≥ 0.8 while WebGL read 0.515; and the `isSunVisible` read was corrupted by the sun-hidden render. **v3 measures both toggle positions inside one step** — four renders per step, `{eclipse off, on} × {sun shown, sun hidden}` — which deletes the cross-run axis entirely (same tiles, same frame-number neighbourhood, one shared mask) at zero extra rendering cost. Current checks: `alphaExactlyOne` (published alpha exactly `1` with the effect off — the identity proof, `x * 1.0 === x`), `toggleObserved` (`eclipseState.enabled` flipped both ways every step), `physicsStillComputed` (fraction still sweeps 1 → 0 when off), **`cullStateUnchanged`** — the legacy binary cull's per-step state (`isSunVisible`, `hasSunCommand`, `sunCommandHasBV`) is IDENTICAL on and off, read via a `scene.postRender` listener that ignores sun-hidden frames; this is the real "S1 did not touch the cull" pin and it holds whether or not the cull ever fires — `cullNonVacuous` (≥1 step actually un-culled), `boundingVolumeShape` (WebGL's sun `DrawCommand` carries a bounding volume, WebGPU's `WebGPUDrawCommand` carries none — the structural backend fact, independent of firing), `identityWhereUnoccluded` (`abs(glowOn − glowOff) / max(glowOff,1) ≤ 0.02` over steps with `fraction === 1` **and settled tiles**, requiring ≥5 such steps; falls back to 0.05 over all unoccluded steps only if fewer, with `identityRelaxedReason` recorded, and structural if none), and `eclipseVisiblyApplied` — a **three-tier, non-vacuous-by-construction** band gate, because the round-3 run returned a null ratio on WebGPU: its additive blend saturates the inner glow to 255 with the effect off, and the saturation mask then discards exactly the sun-bearing pixels, leaving only globe pixels whose difference is 0. Tier 1 `primary-masked` — brightness-weighted ratio `sum(glowOn) / sum(glowOff) < 0.8` over partial-band steps with ≥300 unsaturated px inside 1.5×..6× the limb radius, requiring ≥5 such steps (WebGL lands here: measured 0.491 == expected 0.491). Tier 2 `wide-masked` — same gate with the mask sourced from the wider 1.5×..10× annulus (the ROI was widened 6.5× → 10.5× for this; the glow falls off radially, so the outer ring still holds unsaturated sun-bearing pixels). Tier 3 `raw-strict` — over the **unmasked** 1.5×..6× annulus, require `glowOnRaw < glowOffRaw` at EVERY partial-band step (≥5 steps); saturation can only understate the dimming, so this one-sided count can never manufacture a pass. **The asymmetry is mask SOURCING only** — within any single step `glowOn` and `glowOff` always sum over the identical pixel set, so every ratio compares like with like; the tier used plus `bandTierReason` are recorded so a fallback can never pass silently. **Tier NA `NA-geometric-limb` (WebGPU only, measured):** the round-4 run found `glowOnRaw == glowOffRaw == 0` at ALL 15 partial-band steps (fraction 0.990 → 0.001, effect off AND on) — **the WebGPU sun's glow does not extend above the earth limb at all**, so no eclipse effect could be observed in that band no matter how it were implemented. That is a PRE-EXISTING backend sun-RENDERING divergence (filed as measured evidence on the `C12-15`/`C12-16`/`C12-17` rows; C12-16's terminating `1-smoothstep(0,0.55,r)` glare falloff and C12-17's fixed 256² 8-bit bake are the co-suspects), not an S1 defect. The probe detects it BY MEASUREMENT (`partialGlowOffRawMax === 0`, recorded with `partialGlowOnRawMax`), reports the NA tier with its reason string, and **formally requires lane (b)'s `alphaIsLinear` + `partialEclipse`** — the open-sky moon eclipse, where the sun is high and nothing occludes the annulus — so the proof is delegated explicitly, never exempted (verified: lane (b) red ⇒ lane (c) fails; non-zero glow ⇒ normal `raw-strict`; WebGL never takes this arm). `crossToggle.deferredToLaneB` records the delegated results. **Until the C12-15..17 sun-appearance wave lands, visible earth-limb dimming is unobservable on WebGPU and the moon-eclipse lane is the WebGPU proof of eclipse-alpha application.** **Whether the legacy cull fires is REPORTED, not gated** (`cull.onFlipStep`, `offFlipStep`, `visibleStepCount`): the sun's glow bounding volume is ~4.2e9 m against a ~6.4e6 m Earth occluder, so `Occluder.isBoundingSphereVisible` takes its rarely-exercised "occludee larger than occluder" path — as it happens it DOES fire on WebGL (round-3: `visibleStepCount` 77, `onFlipStep == offFlipStep == 77`), but gating on that would still be asserting a premise the invariance gate already covers either way. Also reported: `bandRatioMeasured` vs `bandRatioExpected` (`sum(glowOff·f) / sum(glowOff)`), `partialStepsOverFloor{Primary,Wide}`, `partialMaskedPx{,Wide}{Min,Max}`, `tiles.settledSteps`, `meanSaturatedFrac`, and a 4-bin radial `meanSaturationProfile` / `partialSaturationProfile` across 1.5×..10× showing WHERE the additive blend clamps. MEASUREMENT: each step renders FOUR times at the same pinned time/camera — `{eclipse off, on}` × `{sun shown, sun hidden}` — and integrates \|luminance difference\| over the glow annulus (1.5×..6× the projected solar limb radius). That difference image isolates the sun exactly, is zero where the globe covers it, and scales EXACTLY linearly in alpha under both blend states (`ALPHA_BLEND` gives `out − dst = a·(src − dst)`, additive gives `out − dst = a·src`). Both sums share ONE mask built from the eclipse-OFF (brightest) capture with 8-bit-saturated pixels excluded — WebGPU blends additively and an un-faded sun clamps at 255, which otherwise pulls that backend's ratio toward 1. Four renders per step across one sweep costs exactly what two renders per step across two sweeps cost. `scene.sunBloom` forced OFF (WebGPU's is unwired, C11-160). All fleet probe rules (pinned clock on every render, sun-dir settle loop, same-task capture, `locator('canvas')` element PNGs, rendererType hard-fail, sanity floors, 420 s unref watchdog, bounded loops, exit 0/1/2) + **provenance hard-gate**: the exact new source lines (read out of the source at run time, never hardcoded) must appear VERBATIM in the built bundle, all of `u_eclipseAlpha`/`eclipseAlpha`/`sunEclipseAlpha`/`enableEclipse`/`sunVisibleFraction`/`earthOcclusionFraction`/`moonObscuration` must be present, and the bundle mtime must be newer than every touched source. Companion pure spec `eclipse-state.spec.mjs` (`node --test`, 28 tests). Run both after touching `EclipseState.js`, `computeSolarObscuration.js`, `Sun.js`, `SunFS.glsl`, the sun WGSL/`packSunUniforms`, or the `isSunVisible` cull in `Scene.updateEnvironment`. **LANE (b) IS BLEND-MODEL AWARE SINCE C12-29 S2 (2026-07-24).** The two backends do not share a blend equation and only one is `dst`-independent: WebGL `ALPHA_BLEND` gives `out − dst = a·(src − dst)`, WebGPU additive gives `out − dst = a·src`. This lane's metric IS that difference image, so once S2 began dimming the sky the sun is composited over, WebGL's raw ratio started over-reporting for a reason unrelated to the sun's alpha — measured causally by the executor: toggling `eclipseAutoExposure` (which changes ONLY the S2 scene factor, leaving S1's alpha bit-identical) moved the measured glow **4.8×**. The four-render pattern already captures the sun-HIDDEN frame in both toggle positions — that IS `dst` — so `measure()` returns `bgSum` and, with the sun texture's own alpha `A ∈ [0,1]`, the ratio is bracketed by `[f, f·(1 + Σ(dstOff − dstOn)/ΣD_off)]`. The `dstLift` upper bound is applied on **WebGL only**; WebGPU keeps the tight historical band its blend makes valid. `dstSum{On,Off}`, `dstDelta`, `dstLift`, `linearUpper` and `blendModel` are all in the manifest so the correction is auditable. **S1's contract never needed correcting** — `alphaEqualsFraction` is bit-for-bit on both backends and was green throughout; only the luminance proxy was confounded. **AND THE PROXY IS READ IN THE BLEND'S OWN SPACE (round 4).** The dst correction fixed the CEILING, but the measured WebGL ratio was undershooting the FLOOR (0.209 vs 0.257), which no dst term can cause: the captured bytes are display-encoded while the blend runs in linear space, and `\|E(a·src + (1−a)·dst) − E(dst)\|` is COMPRESSIVE in `a` because E is concave. `measure()` now integrates BOTH `glowSum` (display) and `glowSumLinear` (sRGB EOTF per channel before differencing, with `bgSumLinear` so the dst correction is computed in the same space as the ratio it corrects), and the gate runs in whichever space that backend's blend actually operates in — **determined by measurement, not presumed**: WebGPU is the analytic control (additive, no dst term, so the difference is exactly `a·src` in its own blend space, and whichever space reproduces `f` there IS that space). `additiveControlIsExact` GATES, so a broken control fails loudly instead of silently mis-reporting WebGL. `blendSpace`, `ratioDisplay`, `ratioLinear`, `errDisplay`, `errLinear`, `dstLift` and `dstLiftLinear` are all in the manifest. **LANE (b) GATING IS SYMMETRIC BY PHYSICS, NOT BY SHAPE (orchestrator ruling, terminal cycle 2026-07-24).** WebGL's sun-glow luminance RATIO is **REPORTED-NOT-GATED**: three independent models were tried against it and all three failed — naive linear, dst-corrected display (round 2), dst-corrected linear (round 4) — and the measured **0.2089 sits BELOW the analytic floor `f` in BOTH spaces**, which no dst term and no encoding can produce. The proxy is confounded by compositing effects none of our models capture, and widening a band around it would only make the gate mean less. The replacement is structural and lives in `applicationProof`: **each backend must carry at least one GATED proof that the eclipse alpha reaches pixels** — WebGL's is lane (c)'s `eclipseVisiblyApplied` primary-masked band ratio (0.491 == expected, green three cycles running); WebGPU's is lane (b) `alphaIsLinear`, analytic because its additive blend makes the difference exactly `a·src` (control exact at 2.4e-5) and because its lane (c) is `NA-geometric-limb` already delegating there. `alphaEqualsFraction` — S1's actual contract — stays GATED on BOTH backends, always. `applicationProof.gatedResult` is part of `PASS`. **If a future change flips a backend's blend model (C11-115 moving WebGPU to ALPHA_BLEND is the live candidate), the additive control disappears, lane (b) stops being analytic on that backend, and the gating lane MUST be re-derived** — `eclipse-scene-dimming.spec.mjs` pins the structure so that change fails loudly instead of silently leaving a backend with no gated pixel proof. Non-boolean diagnostics live in `laneBDiagnostics`, not `laneB`, because the aggregate is `Object.values(laneB).every(Boolean)` and a diagnostic that legitimately measures 0 would otherwise fail the lane. **This probe is the regression gate the S1-before-C12-18/C11-160 pin (maintainer ruling E5) exists to create — run it before and after the sun-PP refactor.** ⛔ **`NA-geometric-limb` RATIONALE CORRECTED 2026-07-25 (C12 sun wave round 3).** The TIER is still right — nothing measurable lives in that annulus — but the recorded REASON ("the WebGPU sun's glow does not extend above the earth limb", "a PRE-EXISTING backend sun-RENDERING divergence", "unobservable until the C12-15..17 wave lands") is **WRONG**, and that wave is NOT what unblocks it. `probe-sun-glow-profile` measured `frameState.sunAtmosphereExtinction` — computed backend-agnostically in `Sun.js` before the branch point — as byte-identical on both backends and `[0,0,0]` below −19.0°: **the sun is fully EXTINGUISHED there on BOTH backends, so WebGPU's zero is the physics executing correctly and there is no sun to dim.** WebGL's residual at those steps is the anomaly; the leading mechanism is that a BLACK billboard under this probe's own `ALPHA_BLEND` darkens the sky by `a·dst` while the same black billboard is an exact identity under WebGPU's additive blend. At the one non-extinguished step WebGPU measures **120% of WebGL**, and the Batch-760 open-sky 77% asymmetry does not reproduce (0.06% per-bin agreement). **Lane (c)'s formal deferral to lane (b) should be re-derived on the corrected premise** — deferring is still right, the stated cause is not. Note also that this probe's `scene.sunBloom = false` line is LOAD-BEARING: `scene.sun.show` gates the WebGL sun bloom as well as the billboard, so it is not a single-variable lever without that pin. |
| `probe-eclipse-scene-dimming.mjs` | **Eclipse scene-light + atmosphere dimming (C12-29 S2, 2026-07-24), both backends + toggle-off identity + the ruling-E2 mode switch.** Guards the four S2 injection sites, all of them JS uniform sources so both backends inherit one change: scene direct light (`UniformState` `_lightColorHdr`+`_lightColor`, post-LDR-clamp, SunLight-gated -> `czm_/csm_lightColor`+`Hdr` + the WebGPU globe camera UB), the sky-atmosphere shell (`SkyAtmosphere.js` `_eclipseLightFactor` closure + `WebGPUSkyAtmosphereRenderer` `uniformData[39]`), the globe ground atmosphere AND its fog (the single `tileProvider.atmosphereLightIntensity` mirror in `Globe.js`, read by `AtmosphereCommon.glsl` on WebGL — whose result IS `GlobeFS`s fog colour — and by `WebGPUGlobeSurfaceCameraUB`/`TileUB` on WebGPU), and `frameState.skyBrightness`. **THE CAMERA LOOKS AWAY FROM THE SUN** (anti-solar azimuth, 10 deg down-pitch, 60 deg FOV, from the derived ground vantage): the S1 sun billboard is not in frame, so nothing this probe measures can be explained by S1s alpha fade. Bands are split at the horizon row found by BINARY-SEARCHING `camera.pickEllipsoid` (never assumed): sky band above, lit-ground band below. `globe.enableLighting` is switched ON — stock Cesium has it off and with it off `GlobeFS`/`GlobeTerrain.wgsl` never multiply by the scene light at all, so injection site 1 would be unobservable (sites 2 and 3 are default-path regardless). **LADDER, NOT SWEEP:** five instants derived IN-PAGE from Simon1994 around the 2026-08-12 eclipse over an Iceland/Spain ground vantage at target obscurations 0 / ~0.35 / ~0.65 / ~0.85 / maximum (the fixed targets live in `eclipse-ladder-rungs.mjs` and cross into the page as DATA; the fifth rung is the clamped maximum the vantage actually reaches) (2 regions x 3x3 grid x 301 minute samples, then +/-100 min at 10 s resolution; the probes own uniform-disc implementation LOCATES the rungs, the ENGINEs limb-darkened value is what is asserted; rungs must be >0.1 apart or the run is structural). Each rung renders the SAME pinned instant THREE times — `{enableEclipse off}`, `{on}`, `{on + eclipseAutoExposure}` — and the metric is the WITHIN-STEP ratio `dim = lum(on)/lum(off)` per band. That deletes two axes at once: the rungs are up to ~90 min apart so their raw luminances are not comparable at all (the ratio cancels sun elevation), and cross-run comparison — the thing that cost S1 three redesigns — never happens. CHECKS: `offFactorAllExactlyOne` (the OFF position publishes EXACTLY `1`; `x * 1.0 === x` is the identity proof), `toggleObserved`/`autoExposureFlagObserved` (both flags flipped both ways every step), `physicsRunsWhenOff` (`moonObscuration` identical on and off — application is gated, computation is not), `clearStepIdentity` (at the zero-obscuration rung both bands agree within 5e-3), `sanityFloors` (absolute: OFF sky mean > 0.08, ground > 0.02, saturation < 50% — a blank or blown-out canvas cannot pass vacuously), `monotoneSky`/`monotoneGround` (sorted by DESCENDING published factor, both dim series non-increasing within 2%), `skyBracketOk`/`groundBracketOk` (a linear light multiply of `f` lands in an 8-bit capture between `f` and `f^(1/2.2)` — the display gamma — with the ground band allowed higher because it carries ambient and base-colour terms the eclipse does not scale; ABOVE the bracket is a token change, BELOW it is over-application), `deepestDimsVisibly`, `floorRespected`+`floorExactAtTotality` (the published factor never goes below `pow(5/100000, 1/3)` ~ 0.03684, and lands ON it within 1e-9 at obscuration >= 0.995 — the floor is recomputed IN THE PROBE from the two published illuminance figures, so a silent retune of the engine constant fails here instead of riding along), `notBlackAtDeepest` (both bands > 0.004 mean — totality is civil twilight, not night), and the ruling-E2 lane `aeFactorStrictlyLower`+`aeIdentityWhenClear`+`aeRendersDarker` (camera mode publishes the LINEAR radiometric factor, strictly below the eye-adapted default at every eclipsed rung, and renders correspondingly darker). PARITY: the published factor is ONE CPU module so `factorParity` demands f64 agreement (< 1e-9) and GATES; the measured dim series are two different shader stacks so `dimSeriesAgree` is REPORTED, never gated — reference disagreement there is structural information about the two sky/globe shaders. All fleet probe rules (pinned clock on every render, per-rung sun-direction settle because the clock JUMPS between rungs, bounded tile settle, same-task capture, `locator('canvas')` element PNGs, rendererType hard-fail, 420 s unref watchdog, bounded loops, exit 0/1/2) + provenance hard-gate with NUMERAL-FREE markers (esbuild rewrites `1.0` -> `1`; S1 learned this the hard way). **Injection site 5 (WebGPU MODEL direct lighting) is pinned at source + provenance level, not measured:** `ModelPBRComplete.wgsl` reads NO `csm_lightColor*` — its direct term is fed raw from `frameState.light` by `WebGPUModelRenderer.packLightUniforms` — so it needs its own multiply, and the probe requires both new lines verbatim in the built bundle; the probe scene contains no model, so a model lane is the honest follow-up. **Bounds are derived THROUGH the display transform:** both backends run the sky and the globe atmosphere/fog drape through Khronos PBR-Neutral tonemapping + inverse gamma on the default LDR path, and that compressive shoulder puts the measured ratio ABOVE a naive `f^(1/2.2)` bound (worked example: scene-linear 2.0 with f=0.216 measures 0.666 vs a 0.558 naive bound — a guaranteed false FAIL at the deep rungs), so `predictDim` inverts gamma, inverts PBR-Neutral by bisection, scales by the factor and re-applies the transform, and the bracket is a band around THAT. **The floor gate is a curve-prediction check, not an endpoint check:** the curve reaches the floor at obscuration exactly 1.0 and nowhere below it (0.995 → 0.171563, 0.9999 → 0.053132), so `curveMatchesPrediction` compares the published factor against a SECOND implementation of the S2 curve at the MEASURED obscuration at every rung in both E2 modes, `floorRespected` is a bound everywhere, and `floorExactAtTotality` fires only at obscuration 1.0. **Rung classes must PARTITION** (`rungsPartition`): a rung in the old unclassified (1e-6, 0.01] gap is STRUCTURAL, not a failure. **Cross-context factor parity is gated on the ICRF/TEME branch matching** (`icrfBranch` recorded per rung per context): `Transforms` substitutes the TEME pseudo-fixed rotation while IAU2006 XYS data loads, the two disagree by ~0.3-0.4° in 2026 (larger than the solar disc), and the settle loop cannot catch it because it only demands the sun direction STOP MOVING — which a stuck TEME frame satisfies perfectly; a mismatch is STRUCTURAL, never an engine failure. Also numeric end-to-end on both backends: `lightUniformCarriesFactor` requires `uniformState.lightColorHdr === light.color * light.intensity * factor` at every rung. **Rung separation is validated in the NODE DRIVER, not in the page** (`validateLadderSeparation`, `eclipse-ladder-rungs.mjs`) — it is pure data validation over the returned ladder, so putting it behind the `page.evaluate` boundary made it untestable and that is exactly how a harness defect shipped: the predicate was `cur > prev + 0.1` STRICT against targets ending `[0.9, min(best.o, 1.0)]`, and since `0.9 + 0.1` rounds to exactly `1.0` in IEEE double, EVERY total or near-total eclipse (i.e. every interesting one) aborted the run as "rungs collapsed" before a single measurement. Fixed three ways, because either single fix leaves a reachable knife edge: the deepest fixed target drops to 0.85 (0.15 designed gap against a total eclipse), the enforced separation drops to 0.05 (3x headroom over the ~1e-3 pick jitter that an epsilon alone could never absorb — the rungs are the instants CLOSEST to each target, not the targets), and the comparison is `>=` with a 1e-9 epsilon so an exact tie can never be the discriminator. The failure message now names the offending PAIR and the predicate. **The sky band is NOT the shell alone** (Edge finding I1, both backends, growing with obscuration — deepest rung WebGL 0.152 vs a 0.133 shell-only bound, WebGPU 0.180 vs 0.128, while GROUND tracked everywhere): the shell composites with ALPHA_BLEND over the skybox/star cubemap and its alpha is luminance-dependent (`mix(color.b, 1, heightOpacity)`), so as S2 dims the shell its alpha falls and MORE un-dimmed background shows through — the measured `L ≈ f·L_shell + c` signature. Starlight is a legitimately non-solar source and **a starrier totality sky is physically correct** (E3/S6), so the INSTRUMENT changed, never the stars: two extra captures per rung with `skyAtmosphere.show = false` (both toggle positions, same pinned state) measure the fully-revealed background `B`, and the sky prediction becomes a bracket over the unknown revealed fraction (`c = 0` shell-only at the low end, `c = B` at the high end; monotone in `c`). Falsifiable, not assumed: `cRecovered` is bisected back out of the measurement and `backgroundRevealExplains` reports whether it fits inside `B` — a false there REFUTES the reveal hypothesis and means something else is adding light. `backgroundIsToggleInvariant` GATES that the background does not move with the toggle (star modulation is default-off since C11-176; S2 reaching the star field would be an S6/E3 decision). **The visual lane is captured IN-TASK** (Edge finding I3): a post-evaluate `locator(canvas).screenshot()` runs after the page is restored to the live wall clock with no globe, so it shipped a black default view — the deepest rung is now read as canvas data URLs inside the same task as its render, eclipse ON and OFF, both backends, written from Node as `eclipse-scene-dimming-<renderer>-deepest{On,Off}.png` and listed in the manifest as `shotsWritten`. **★ THE SKY/GROUND GATE IS AN EQUIVALENCE, NOT A PREDICTION (round 4, terminal).** Round 3 killed the background-reveal hypothesis with its own falsifiability machinery (`backgroundRevealExplains` FALSE on both backends at every rung; `cRecovered` 0.05-0.72 vs an available background of 0.015-0.017 — 3.5-42x more un-dimmed light than the skybox can supply), and the rung-1 signature (factor 0.866 -> `dimSky` 0.986) identified the real term: the shell response to `atmosphereLightIntensity` is strongly SUB-LINEAR in the bright regime. After three modelling rounds each leaking somewhere new, the gate stopped modelling: per eclipsed rung it takes ONE extra capture with `enableEclipse` OFF and the same factor applied MANUALLY through the public surfaces — `scene.light` colour x f (site 1), `skyAtmosphere.atmosphereLightIntensity` x f (site 2), `globe.atmosphereLightIntensity` x f (site 3, whose `tileProvider` mirror is VERIFIED to match, not assumed) — and requires per-band agreement within **2% relative + 0.005 absolute** (`equivalenceOk`, `equivalenceWorstRel`; the tolerance rationale and its first-run calibration status are recorded in-file). Model-free: every nonlinearity applies to both paths and cancels. Two preconditions are ASSERTED, not trusted — sun intensity is forced to **1.0** because site 1 dims AFTER the LDR clamp while manual colour scaling dims before it (at the stock 2.0 the clamp divides a manual factor above 0.5 straight back out), and `scene.aerialPerspective` must be OFF or `frameState.light` becomes the derived light on WebGPU only and the manual scaling is a silent no-op there. Site 4 is excluded (no public setter, byte-inert at defaults — asserted via `enableStarBrightnessModulation`); site 5 is N/A (no model in the scene). All manual values restored before anything else renders. `predictDim` / `cRecovered` / `backgroundRevealExplains` / the brackets are KEPT as `*ReportedOnly` diagnostics documenting the saturating-shell physics. **CALIBRATED AND TIGHTENED (terminal cycle, 2026-07-24):** the equivalence band opened at rel 2% + abs 0.005 as a first-run estimate and has been measured — **WebGL worst relative deviation 5.876e-7** (sky band, deepest rung), **WebGPU 0, BIT-IDENTICAL across 8 of 8 bands** — so it is now rel **1e-4** + abs **1e-5**, still >100x headroom and 200x tighter than the estimate, with both measured numbers recorded in-file beside the constants they justify. Note the read-after-render invariant this exposed: `tileProvider.atmosphereLightIntensity` is captured IMMEDIATELY after the ON render, because the auto-exposure capture renders with `eclipseAutoExposure = true` and then resets the flag WITHOUT re-rendering, leaving the mirror holding `base x f_AE` — a stale read that failed `mirrorMatches` while the engine was correct. Companion pure spec `eclipse-scene-dimming.spec.mjs` (`node --test`, 31 tests — four pinning the ladder class, one the three Edge-cycle instrument fixes, one the model-free redesign, one the symmetric-by-physics gating structure) whose headline pin is a 24-hour Dallas day/night sweep demanding the scene factor be EXACTLY 1.0 at all 360 samples — that is what stops anyone re-deriving S2 from `sunVisibleFraction`, whose Earth-limb term saturates through twilight and would black out every sunset. Run both after touching `EclipseState.js`, `UniformState.js`s light block, `Globe.js`s tileProvider mirror, `SkyAtmosphere.js`, `WebGPUSkyAtmosphereRenderer.js`, or the eclipse publish site in `Scene.render`. |
| `probe-sun-glow-profile.mjs` | **Sun-billboard RADIAL LUMINANCE PROFILE, webgl-vs-webgpu (C12 sun wave — C12-15/C12-16/C12-17 — plus the C12-29 S4 lane, 2026-07-25).** THE DIAGNOSTIC for `probe-eclipse-sun-fade`'s `NA-geometric-limb` finding (WebGPU `glowOffRaw == glowOnRaw == 0` over the 1.5×..6× solar-radius annulus at all 15 partial-band steps while WebGL measured 0.491). It turns "the WebGPU glow dies at the limb" into a measured curve **as a function of angular radius in SOLAR RADII** — 0.5-R_sun bins out to 12 R_sun — at TWO matched vantages: `open-sky` (400 km, sun 14.8° clear of the limb, the geometric control) and `near-limb` (probe-eclipse-sun-fade lane (a)'s own band, elev −19.0 .. −22.6 in five steps). **Four renders per step at one pinned clock and one fixed camera: `{globe shown, globe hidden} × {sun shown, sun hidden}`.** Hiding the globe removes the ROI's only depth writer, so the two difference profiles separate "the sun did not draw" from "the sun drew and was clipped" **by measurement**, not inference. Per bin: `sunDelta`, `sunDeltaNoGlobe`, `bgMean`, `bgMax`, `bgSatFrac`, `litMean`, `globeFrac`, distinct-value count (the quantisation signature). Per step: `isSunVisible`, `hasSunCommand`, `sunCommandHasBV`, `sunEclipseAlpha`, `sunAtmosphereExtinction`, `limbPx`. **Hypothesis table, written before the first run** — `H-OCCL` (depth clip): `sunDelta ≈ 0` with the globe shown but `sunDeltaNoGlobe` LARGE in the same bins and `globeFrac` high (decisive). `H-SAT` (background already 8-bit saturated, so an additive add is invisible): `sunDelta ≈ 0` AND `bgMean > 250` AND `sunDeltaNoGlobe ≈ 0` — **not the sun's bug**, it belongs to the sky/exposure lane (S2 obs-1) and the verdict string says so. `H-ABSENT`: both differences ≈0 at near-limb, both large at open-sky. `H-GEOM`: the backends' `r10` differ by >20% at OPEN sky. `H-FALLOFF`/`H-QUANT`: confined to rho > 8 R_sun by construction. **C12-16 and C12-17 are REFUTED as causes of the zero before this probe even runs** and the refutation is pinned in `solar-disc-model.spec.mjs`: the legacy glare terminates at 8.556 R_sun and the `rgba8unorm` 1/255 floor bites only beyond 8.199 R_sun, while the billboard's alpha inside the measured annulus is 0.689 (1.5 R_sun) down to 0.161 (6 R_sun) — 8-bit codes 176..41. Reshaping a falloff that is already at alpha 0.16..0.69, or giving it more bits/texels, cannot turn a measured zero into a non-zero. **The webgl-vs-webgpu near-limb divergence is reported as STRUCTURAL, never gated** — it is the subject under investigation, and a probe that fails on its own phenomenon cannot report it. GATES (post-fix acceptance for the three rows): `provenance` (numeral-free source markers verbatim in a bundle newer than every touched source); `sanity` (open-sky `annulusFreeSum > 1000` on both backends — an all-black canvas cannot pass vacuously); **`c12_16_support`** — open-sky support radius (outermost bin with mean ≥ 0.5 luminance) in **9.5..11.75 R_sun on BOTH backends**, i.e. C12-16's Lorentzian reaching the billboard's inscribed circle at 11.0 instead of terminating at 8.556 (**RED before the fix — that is the point**); `geometry_lockstep` (`r10` within 20% between backends, the H-GEOM arm); **`c12_17_bake`** — at 1280×720 both backends bake 512² (WebGL's own `2^(ceil(log2(max(w,h)))−2)` rule), WebGPU format `rgba8unorm` in SDR / `rgba16float` under HDR; **`c12_15_appearance`** — `frameState.sunDiscAppearance` published with `key == 3`, `a0 == 0.3`, `glareLegacy == 0`, and **byte-identical JSON between the backends** (the C12-15 one-constants-source contract read LIVE, not from source text); `eclipse_identity` (`sunEclipseAlpha` exactly 1.0 with `enableEclipse` forced false — the S1 contract pin, and what makes every globe-on/globe-off difference here pure occlusion); `console`. All fleet rules (pinned clock on every render, bounded sun-direction settle, same-task capture, `locator('canvas')` element PNGs, rendererType hard-fail, 420 s unref watchdog, bounded loops, helpers inside `page.evaluate`, exit 0/1/2). No GPU-timing claim ⇒ the interleaved bundle-swap A/B protocol does not apply. Run after touching `SunTextureFS.glsl`, `Scene/SolarDiscModel.js`, `Scene/SunDiscAppearance.js`, `Sun.js`, or `createSunTexture`/`packSunUniforms` in `WebGPUEnvironmentRenderer.js`. Companion pure specs: `solar-disc-model.spec.mjs` and `sun-orbital-limb-extinction.spec.mjs`. **ROUND-2 (2026-07-25) — this probe's round-1 constants NEVER PRODUCED A MEASUREMENT**, and two classifier defects would have printed a confidently wrong verdict; all fixed, all pinned. (a) GEOMETRY: viewport 1280x720 + fov 12° + maxRsun 12.0 is arithmetically unsatisfiable — limbPx 27.94, maxHalf floor(0.45·720)=324, and the guard `half < maxRsun·limbPx` reduces to `324 < 335.29`, so it exited 2 at step 0 on every run, forever, before any fix-dependent code; even relaxed the ROI reached only 11.60 R_sun, BELOW its own 11.75 support-gate bound. Fixed by fov 12°→**20°** (a WIDER fov shrinks limbPx; narrowing it — the intuitive move — is the wrong direction), giving limbPx 16.6–17.2 and an ROI reach of **12.53–12.55 R_sun with 1.57–1.63× margin** across perihelion..aphelion. Two structural guards so the class cannot ship again: a pure `roiFeasibility()` run over the whole distance range BEFORE the browser launches, and `solar-disc-model.spec.mjs` extracts the constants block and that function VERBATIM (`==BEGIN PROBE_CONSTANTS==` / `==BEGIN roiFeasibility==`) to assert satisfiability, assert the round-1 set is still REJECTED, and assert the in-page expressions still match the pure model. (b) LANES: three now, each varying ONE knob — L0 base (globe ON, sky ON), L1 sky-off (SATURATION-ATTRIBUTION only), L2 globe-off. (c) M1 — H-SAT is evaluated BEFORE H-OCCL and H-OCCL additionally requires an UNSATURATED L0 background: at this vantage the annulus pixels ARE the sunlit Earth limb and WebGPU's additive sun clamps them at 255, so hiding the globe removes the SATURATOR and produces the occlusion signature for a saturation cause. `bgMean`/`bgSatFrac` measured WITH the globe present is the direct discriminator, recorded every step. (d) M2 — absence is settled at STATE level, never by pixels: `globe.show = false` varies THREE things (depth writer, saturator, and the legacy cull — `SceneUtilities.getOccluder` returns undefined when the globe is hidden), so a CULLED sun also produces "recovered when the globe is hidden". The probe reads `environmentState.isSunVisible` / `hasSunCommand` / `sunCommandHasBV` in the SAME task right after the sun-SHOWN render. (e) HYPOTHESES NARROWED FROM SOURCE, not by this probe: the executor's clean-main run measured WebGPU **open-sky glowOff 1,732,142 vs WebGL 2,241,410** (the WebGPU sun renders at 77% there and contributes exactly 0 near the limb), which EXCLUDES H-GEOM/H-FALLOFF/H-QUANT; and a concurrent fleet established that **the sun is binned AFTER the atmosphere** (`SceneRenderer.js:348-357`), which ELIMINATES "an opaque sky shell occludes the sun" — so that hypothesis was deleted rather than measured. What survives is that the shell (or the globe) can SATURATE the destination the additive sun blends into, which the background lanes attribute. The dynamic-atmosphere-lighting enum is still recorded per backend as a cheap REPORTED diagnostic. `sunDeltaNoSky` is `_DIAGNOSTIC`-suffixed and never selects a hypothesis, because hiding the shell also flips `frameState.skyAtmosphereVisible` and thereby forces the sun's own extinction to identity (up to 1e5× in red by the S4 table); `skyLaneExtinctionConfound` flags it. (f) `provenance()` now DEGRADES on a missing source instead of throwing, so a PRE baseline is always runnable. **ROUND 3 (2026-07-25) — THE DIAGNOSIS, AND A LEVER LESSON THAT APPLIES TO EVERY SUN PROBE.** The measurement: `frameState.sunAtmosphereExtinction` (computed BACKEND-AGNOSTICALLY in `Sun.js` before the branch point) read **byte-identical on both backends** at all five near-limb steps — `[0.723, 0.467, 0.190]` at −19.0° and `[0,0,0]` (< 5e-4/channel) below — and both backends multiply the billboard's RGB by it. **Extinction 0 ⇒ black billboard ⇒ delta 0: WebGPU's zero is the physics executing correctly, and the sun is genuinely extinguished at those elevations on BOTH backends.** WebGL's non-zero at the same steps is the anomaly. Leading mechanism, from source: WebGL's sun uses `ALPHA_BLEND`, so `out = src.rgb·src.a + dst·(1−src.a)`, and with `src.rgb == 0` that is `out = dst·(1−a)` — **a black billboard DARKENS the sky by `a·dst`**, while WebGPU's additive `src-alpha`/`one` makes `src.rgb == 0` an exact identity. That reproduces every observation (residual exactly where the billboard is black, magnitude tracking `bgMean`, collapsing to 0 at −22.6° where nothing is drawn), and at the one NON-extinguished step WebGPU reads **1,176,861 vs WebGL 982,022 = 120%, brighter not absent**. The Batch-760 'open-sky WebGPU = 77%' asymmetry does not reproduce — the two suns agree to **0.06% per radial bin**. ⚠ **`scene.sun.show` IS NOT A SINGLE-VARIABLE LEVER ON WEBGL.** It sets `environmentState.isSunVisible`, which gates a whole-frame bright-pass+blur+copy (`EnvironmentRenderer.js:43-58`) and a framebuffer redirect (`FramebufferOrchestrator.js:49-53`) in addition to the billboard. **Any future sun measurement must pin `scene.sunBloom` explicitly** — every lane here does, `gates.bloom_pinned` fails loudly if it drifts back to Scene's default TRUE, and `solar-disc-model.spec.mjs` asserts the pin. New **L3 bloom A/B lane** (near-limb only) runs the toggle in the ON direction, and a **SIGNED** delta (`sunDeltaSigned`, `annulusL0Signed`) discriminates the two mechanisms in one number without any toggle at all: **bloom ADDS light ⇒ positive; a black billboard under ALPHA_BLEND SUBTRACTS `a·dst` ⇒ negative.** Prediction recorded in-file before the run: the bloom A/B will NOT collapse (both bloom sites are gated on `scene.sunBloom`, which every lane already pinned false in the run that produced the residual), so `bloomOnOverOff ≈ 1` and the signed delta is NEGATIVE. `bloomMechanism.verdict` / `.bloomCall` report `bloom-REFUTED` / `bloom-CONFIRMED` / `additive-residual` explicitly, and `context.supportsLegacySunBloom` is recorded per backend. If the residual DOES collapse, `sunBloom = false` was not taking effect and that is the finding. Also on the record from this run, filed as their own rows on `C12-29` (not fixed here): **WebGPU's sun command carries NO bounding volume** (`sunCommandHasBV` false everywhere) so the legacy `Occluder` horizon cull can never fire on WebGPU (WebGL culled at −22.6°, WebGPU reported visible at all five steps); and **WebGPU renders no globe in the near-limb ROI**, shell-independently — `globeFrac` exactly 0, `bgMeanNoGlobe` 155.254 bit-identical to `bgMean` 155.254, and with the shell hidden the ROI reads **1.701 (black)** vs WebGL's **36.94** (WebGL `globeFrac` 0.7725). A shell cannot cause an absence that survives removing the shell, so this is NOT shell opacity — obs-2 territory, with data attached. |
| `probe-eclipse-sky-totality.mjs` | **The totality SKY (C12-29 S6 sky half, 2026-07-25): obs-1's root cause, the ruling-E3 star-brightness default flip, the star reveal, and the 360-degree horizon twilight — both backends.** THREE LANES, every one an EQUIVALENCE or an ALGEBRAIC RECOVERY; there is deliberately **no predictive model of the sky pipeline anywhere in this probe**, because S2 burned three rounds on display gamma -> PBR-Neutral shoulder -> background reveal and its terminal finding was that the shell's response to `atmosphereLightIntensity` is strongly SUB-LINEAR in the bright regime. **(d) SHIPPED DEFAULTS, ground, clear night — runs FIRST, before any scene mutation, and is the gate on the S6 double-draw survivor choice.** The fix retracts the star field's BINNED copy (drawn AFTER the atmosphere) and keeps the INJECT copy (drawn BEFORE it, where `EnvironmentRenderer` executes WebGL's catalogue), so wherever the shell is opaque WebGPU moves from "sprites visible" to "sprites hidden" — CONVERGENCE if and only if WebGL hides them too. So the lane measures, at `globe.enableLighting` UNTOUCHED and every other knob at its constructor default: the shell alpha by the same algebraic background swap as lane (a), sprite visibility by `m1PointSourceCensus` + band delta, and CUBEMAP visibility alongside — and **gates on cross-backend PARITY (`defaultsSpriteParity`, `defaultsCubemapParity`, `defaultsAlphaParity`), never on the expected answer**. If WebGL shows sprites at defaults and WebGPU does not, this lane FAILS and the survivor must become the binned copy. `defaultsAreDefaults` asserts the configuration really is stock (`enableLighting === false`, `dynamicLightingEnum === 0`, sky/skyBox/starField shown). Two STRUCTURAL guards, both learned from other instruments: the band is asserted globe-free by `pickEllipsoid` at its corners + centre, because the sun-glow worker's near-limb run showed `globeFrac = 0` with `bgNoGlobe` BIT-IDENTICAL to `bg` on WebGPU — the globe is absent there even with the shell hidden (obs-2), so any ROI containing globe would mistake a dark globe for an opaque shell; and `spritesVisible === cubemapVisible` is required, since both draw before the atmosphere and an opaque shell must hide BOTH or NEITHER — a disagreement refutes the ordering model and exits 2. **(a) obs-1 — the shell's ALPHA, recovered algebraically.** Under ALPHA_BLEND the captured pixel is `out = a*src + (1-a)*dst`, so rendering the identical pinned frame over two known backgrounds gives `out_white - out_black = (1 - a)` EXACTLY: `a*src` cancels, and with it the tonemap, the gamma, the scattering integral and the saturating shell. A CONTROL pass with `skyAtmosphere.show = false` measures the same difference at `a = 0` and must read ~1 — if it does not, `scene.backgroundColor` is not reaching that backend's clear, the lane is uninstrumented, and the run is **STRUCTURAL (exit 2)**, never a gate failure. Gates `shellIsTranslucent` (recovered alpha < 0.9, so the lane cannot pass on a vacuously opaque frame), `bandNotBlack` (absolute floor), and cross-backend `alphaParity` within 0.08. Also records `scene.skyAtmosphere.dynamicLighting` and `scene.atmosphere.dynamicLighting` per backend, which LOCALISES the finding: Scene resolves SCENE_LIGHT on BOTH backends, so the divergence was always inside the WebGPU renderer. **Pre-fix prediction, stated in-file before the run:** WebGL recovers a low alpha in the anti-solar sky (its shell gets SCENE_LIGHT from `fromGlobeFlags`, so `nightAlpha -> 0` there and `alpha = mix(color.b, 1, 0) = color.b`), WebGPU recovers ~1.0 (its shell got NONE from `frameState.atmosphere.dynamicLighting`, `nightAlpha` pinned at 1, a ground camera's `altitudeOpacity` 1, so `alpha = mix(color.b, 1, 1)` is exactly 1) — an opaque shell with the star cubemap behind it, which IS obs-1. **(b) the E3 multiplier reaches pixels.** The star modulation is a pure multiply on the cubemap, so the SAME pinned frame is rendered twice changing ONLY `starModulationCurve` — inflection 1.0 (factor exactly 1) vs an inflection solved for a 0.5 target at the measured `skyBrightness` — and the star-band mean must scale by that factor (`multiplierReachesPixels`, 15% band; two renders differing in one number, so the ratio IS the multiplier). Then the reveal: eclipse ON vs OFF at the deepest instant, `revealHappens` (ON censuses MORE point sources) AND `revealIsPartial` (fewer than the undimmed reference — "the brightest stars and planets", not a full night sky). Then `offToggleRestoresFull`: with `enableStarBrightnessModulation = false` and a curve that would black the map out (steepness 1000), the band must return to the undimmed mean within 0.01. The census is the fleet's trust-anchored **`m1PointSourceCensus`** ported in-page verbatim (strict 3x3 local maximum, local background = MEDIAN of an r 3..5 annulus, accept only on `v - bg >= 12` AND `v >= 1.6*bg`) — a home-grown census without the prominence arm counted twilight dither as stars during the Batch-761 work, and this lane would hit that failure mode exactly. **(c) the 360-degree twilight, as a DIFFERENCE IMAGE.** Per azimuth (0/90/180/270 off the anti-solar direction) the same pinned instant is rendered with `enableEclipseHorizonTwilight` false then true; the difference IS the added term, with no model needed. `presentAtEveryAzimuth` (delta > 0.004 at all four — the "360" claim), `confinedToBand` (zenith delta <= 25% of the horizon delta, i.e. nothing above the 22.62-degree geometric ceiling), `isWarm` (dR > dB), `bandNotBlack`, and the identity arm: at a derived CLEAR instant the two toggle positions must differ by **exactly** 0 with `frameState.eclipseHorizonTwilight === 0`. FIXTURE SELECTION IS CONSTRAINT-DRIVEN, and this is the second lesson the probe paid for: the in-page pass scores ALL 18 vantages of the 2026-08-12 Iceland/Spain grid and **selects nothing**; the predicates live in the shared `lib/eclipse-fixture-constraints.mjs` and run in the NODE driver, where they are unit-testable and where a rejection can name the constraint that caused it. The earlier selector picked on MAXIMUM OBSCURATION alone and then demanded deepest + clear + NIGHT instants at the winner — jointly unsatisfiable, because the sweep visits Iceland first with a strictly-greater comparison so the first o=1.0 vantage wins, while at 62-66N in mid-August the sun only reaches -9.7 to -12.7 deg (Spain reaches -31.5 to -34.5). Fixed twice over: the night threshold was over-tight and is now DERIVED (-8 deg, the edge of `computeStarDayFade`'s dayFade===1 region at -5.74 deg plus margin — the lanes need engine-dark, not astronomically dark, which keeps the Iceland showcase usable), and the selector now evaluates `totalEclipse`/`sunHighAtEclipse`/`nightReachable` per candidate plus the instant-level `deepestInstant`/`clearInstant`/`nightInstant`, prints the full constraint table every run, and on total failure reports the DOMINANT failing constraint with its tally instead of a bare symptom string. Only the shortlisted survivors are refined to instants (bounded by `FIXTURE_MAX_REFINED`). The probe's own uniform-disc overlap LOCATES the instants; the ENGINE's limb-darkened value is what is asserted, `globe.enableLighting = true` (with it off `fromGlobeFlags` returns NONE on BOTH backends and obs-1 is unobservable by construction), `scene.sun.show = false` (never in frame; removes a glare variable). All fleet probe rules: pinned clock on every render, bounded tile settles, same-task canvas capture (`totalityOn`/`totalityOff`/`clear` PNGs read as data URLs inside the evaluate that rendered them and written from Node), rendererType hard-fail, absolute sanity floors, 480 s unref watchdog, bounded loops, exit 0/1/2, every `page.evaluate` helper defined INSIDE the callback, and a provenance hard-gate whose markers are ENFORCED MECHANICALLY by the shared `lib/provenance-markers.mjs` (extracted from the C12-29 S5 worker's spec so both probes share one implementation): every `VERBATIM_SLICES` entry must be a single bare identifier, >= 12 chars, rename-proof (a property name, or inside a GLSL/WGSL file whose text becomes string CONTENT in the bundle), genuinely present in the SOURCE it names, and carry a `why` justifying it. That rule has FIVE recorded strikes behind it — numeric literals (`1.0` -> `1`), a prettier-wrapped call, `function ()` emitted as `function()`, a local `data` emitted as `data2`, and `data` being too generic to evidence anything — and it is a SPEC rather than a habit because workers cannot run probes, so an unsound marker is otherwise only found by an executor, one per Edge cycle. `eclipse-sky-totality.spec.mjs` proves the check non-vacuous by re-injecting all six defects and asserting rejection, plus two positive controls. Companion pure spec `eclipse-sky-totality.spec.mjs` (`node --test`, 24 tests: the obs-1 resolver contract + the WGSL alpha path it re-enables, the E3 curve re-derived from the totality anchor, one expression across four implementations, the GLSL ordering under HDR, the C11-176 orbital regression closed at the source, the twilight strength/gates/tint/constants, the add-only UB growth, no new ShaderDefine bit, and naga validation of `SkyAtmosphere.wgsl` + both panorama WGSL copies). Run both after touching `SkyAtmosphere.js`/`.wgsl`/`FS.glsl`, `SkyBoxFS.glsl`, `CubeMapPanorama.js`, `StarField.js`, `StarFieldMath.ts`, `SkyBrightness.js`, `EclipseState.js`'s S6 block, or either cubemap-panorama renderer. |
| `probe-env-pass-matrix.mjs` | **Environment-pass independence matrix (C12-G1F1 widened, 2026-07-24), webgl-vs-webgpu.** The acceptance gate AND standing regression net for "every environment element renders independently of which OTHER elements are shown". Root cause it guards: WebGPU injects environment commands into the FARTHEST frustum (`SceneRenderer.js:336-338`) and drops the frame when `frustumCommandsList.length === 0`, but frustum existence was derived from `frameState.commandList` — onto which only SkyAtmosphere, Sun and StarField ever push a binned copy (StarField only while its daytime fade is non-zero); SkyBox is inject-only and Moon redirects the list to a scratch array. So `starField.show=false` killed the WHOLE sky and a moon-only scene rendered at night but blacked out in daylight. Fixed by `Scene/EnvironmentFrustumDemand` (`needsEnvironmentOnlyFrustum` at `View.js:412`). **11 cells** — `all-on`, `starfield-off`, `skybox-only`, `starfield-only`, `skybox+starfield`, `skybox+moon`, `atmosphere-only`, `sun-only`, `moon-only`, `globe-only`, `all-off` — × **2 lanes** (`night` moon ~70° / sun ~−20°, pf 0.60-0.78; `day` moon ~70° / sun ~55°, pf 0.10-0.20), epochs **derived in-page from Simon1994** and the ground observer **solved analytically** (the probe-moon-atmosphere-appearance recipe) so both bodies sit at pinned elevations OUTSIDE the wide sky frame. THREE measurement passes per cell in one evaluate: moon disc ROI (fov 3°, ROI from the projected `moonPositionWC` + limb — no hardcoded pixels), sun disc ROI (projected `sunPositionWC` + solar limb), and a wide fov-60° sky pass aimed +10° elevation yielding sky-band mean/median/RGB + a strict-3×3-local-maximum bright-point census + a diagnostic ground band. Presence predicates are **SHAPE-based, not absolute-luminance** (defect D1, found by the orchestrator's pre-fix run): with the TYCHO_T5 skybox behind a HIDDEN moon, cubemap pixels inside the 3° ROI cleared the original `discMax ≥ ringMean+20 && litFrac > 0.02`, so `day skybox-only`/`day skybox+starfield` read moon=true on the WebGL reference and tripped the probe's own reference-disagreement guard. Absolute luminance fails **both** ways — a Milky Way band with NO body gives a disc/ring mean step of **+37**, while a real daylight crescent occludes that band and reads **~20 LSB DARKER** than its ring. So: lit = above `max(ringP99+20, ringMean+25, 30)` (the ring annulus supplies the LOCAL background distribution), then moon = `litFrac ≥ 0.02 && maxLitComponentPx ≥ 200 && maxLitComponentFrac ≥ 0.5 && litFrac ≥ 6·ringLitFrac` (a rendered body is ONE large 4-connected blob; a star field is speckle whose lit fraction matches the ring's), sun = `discMean ≥ ringMean+20 && discMax ≥ 200 && absLitFrac ≥ 0.10 && absMaxComponentFrac ≥ 0.5` against a FIXED bar of 180 — **the sun uses no ring-derived threshold at all** (defect D2, second pre-fix run): its glare floods its own annulus, so `ringP99` climbs to near-saturation, the ring-relative bar rises ABOVE the disc and `litFrac` collapses to ~0 exactly where the sun is brightest; `day sun-only` read gl=false/gpu=true purely because WebGL's alpha-blended sun fell under the self-raised bar while WebGPU's additive blend saturated to 255 and cleared it. The asymmetry is principled: the sun is the brightest object in any scene so a fixed floor has no false-negative mode, while the moon is not — a daylight crescent sits below any fixed level a bright skybox also clears (D1). The scale-free mean-step arm is what rejects false positives; a uniformly bright field clears the fixed bar but has `discMean − ringMean ≈ 0`, atmosphere = `skyMean ≥ 8 && skyMedian ≥ 4 && B > 1.05·R` (the median arm separates a diffuse lit sky from sparse bright sources), stars = `brightPoints ≥ 3`, where the census is the fleet's trust-anchored **m1PointSourceCensus algorithm** ported in-page (strict 3×3 local max, local background = median of an annulus r 3..5, accept on `v − bg ≥ 12` **and** `v ≥ 1.6·bg`) — defect E2: the earlier home-grown census used a whole-band `median + 25` bar with no PROMINENCE arm and counted an atmosphere-only night sky's twilight dither as stars (expected=false, both backends true — parity intact, so an instrument artifact); `SkyAtmosphere.wgsl` draws no point sources at all (its only "star" hits are the demo name "Star Burst"), so the census had to be the culprit. Defect E1, same class: `night/starfield-only` asserted stars=true but WebGL censuses only ~2 sprite points at DEFAULT brightness, so **that one cell renders at `starField.intensity = 40`** — a public, backend-NEUTRAL knob both feature renderers consume via the same `StarField._effectiveIntensityScale` (`WebGLStarFieldRenderer.js:264`, `WebGPUStarFieldRenderer.ts:596`), so it exercises the identical draw path on both backends and cannot mask a divergence; every other cell restores the captured default so the boost cannot leak (droppable once the C12 star-brightness default-flip lands). Known limit, geometrically unreachable at a 3° ROI and therefore not gated: a bright band crossing the disc but NOT the adjacent 1.25-1.55r annulus. The pure pixel→stats function and `presenceOf` are marker-delimited (`==BEGIN shapeStatsFromPixels==` / `==BEGIN presenceOf==`) and extracted VERBATIM by `env-matrix-shape.spec.mjs` (`node --test`, **18 browser-free anchors** covering all four instrument defects: D1 hidden-body-over-starfield / over-band, daylight crescent over both, night gibbous, black frame; D2 saturated sun, alpha-blended sun under a radially-falling glare halo, bright-flat-sky non-leak, hidden sun; E2 lit-dithered-sky-censuses-zero, real-stars-still-counted-on-black-and-over-lit-sky, m1-parameter pin; D3 the night contract pinned to measured reference values) — the four extractable regions are `shapeStatsFromPixels`, `starCensusFromBand`, `presenceOf`, `evaluateNightSourceContract` — the probe module cannot be imported because its top-level IIFE launches a browser, so keep both regions dependency-free. **A lit atmosphere saturates both the sky band and the near-disc ring**, so every predicate except `atmosphere` is GATED only on atmosphere-OFF cells (`atmosphere` only in the day lane, `stars` only at night, `sun` only in the day lane); atmosphere-on cells still record metrics, marked `diag`. GATE = WebGPU presence === WebGL presence per gated element per cell, plus the night source contract (`evaluateNightSourceContract`) — the direct "starField off hides ONLY the star field" assertion, gated on the CUBEMAP census alone: WebGL `skybox-only` ≥ 200 sources and `skybox+starfield` ≥ `skybox-only` are REFERENCE SANITY (structural if violated), and the gate is `webgpu/webgl skybox-only ≥ 0.5` (pre-fix **0** — WebGPU 0 vs WebGL 1094 — post-fix ~1). **`starfield-only` is INFORMATIONAL, never gated** (defect D3): WebGL's own catalog star field registers just **2** census points at this vantage because at default brightness the Yale-catalog sprites sit below the census bar (`pointThreshold = median + 25`), the known t3/t5 star-brightness behavior — expected, not an error. An earlier revision demanded `starfield-only ≥ 3` and structurally failed the reference itself; the sprite path is still gated cross-backend by the per-cell `starfield-only`/`skybox+starfield` presence rows. A WebGL reference that disagrees with the expected-presence table is STRUCTURAL (exit 2), never a gate failure. Pre-fix RED cells: night `skybox-only`, night `moon-only`, night `skybox+moon`, day `moon-only`, day `skybox+moon`, night source contract. Provenance (`hasInjectedEnvironmentContent`/`needsEnvironmentOnlyFrustum` in the built bundle) is REPORTED as `fixPresentInBuild`, deliberately NOT gated, so a pre-fix baseline run still reaches the cells. All fleet probe rules: pinned clock on every render, bounded settle, same-task capture, canvas-ELEMENT PNGs (5 signal cells only, to avoid 44 full-size images), rendererType hard-fail, 480 s unref watchdog, exit 0/1/2. Companion `env-frustum-demand.spec.mjs` (`node --test`, 11 tests incl. the full 2^6 element-subset matrix) pins the predicate without a browser. Run after ANY change to `View.createPotentiallyVisibleSet`, `Scene.updateEnvironment`, the `SceneRenderer` environment injection, `EnvironmentFrustumDemand`, or any environment primitive's command-emission path. |
| `probe-cloud-lod-hoist-perf.mjs` | **Cloud GPU per-pass timing A/B harness (C13-39, 2026-07-24).** Six lanes (baked-straight/baked-cone/live-escape/shadow-single/shadow-cascaded/ibl) with WORKLOAD-VERIFIED readiness: bounded render-measure-check until cloudCells >= 3000 AND the shader-consumed baked/planet-density bits are set (four distinguishable timeout reasons); the ibl lane loads a 4 KB owner glTF because `DynamicEnvironmentMapManager.update` has NO scene-level caller (only Model/Tileset - spec-pinned exactly-one-call derivation), opts into `cloudsInReflections`, and attributes every observed env fill to the input that triggered it. Pass timings via the Batch-762 `timedCloudPass` timestamp wiring (byte-inert unarmed). **MANDATORY PROTOCOL (header section): interleaved bundle-swap A/B** - build both bundles ONCE, alternate within one session (`TAG=pre`/`TAG=post` per `C13_39_PAIR_ID` round), N>=2 rounds with reversed ordering, discard rounds where occupancy fingerprints move; 40-min-apart runs measured -59%/+98% phantom deltas on UNTOUCHED shaders and are inadmissible. Applies to EVERY GPU-timing comparison in this repo. The C13-39 negative result (hoisting rejected; occupancy-bound march; static register allocation taxes all pipelines) is recorded in the debugging log - read it before attempting cloud-shader perf work. |
| `probe-ground-view-env.mjs` | **Regression gate for the three ground-level environment divergences (Batch 247, NEW-GROUND-VIEW-ENV-DIVERGENCES), webgl-vs-webgpu same-scene numeric.** (1) ground-sky brightness — mean-luminance + HSB-value ratio over the top sky band, band [0.8, 1.25] (post-fix 0.99x/0.99x; pre-fix 1.73x/1.46x — caught the over-converged quadrature + non-WebGL shell geometry + LUT azimuth bug); (2) sun disk at a sun-aimed ground view — bright-pixel count within 180 px of frame center, atmosphere ON must keep the disk (caught the binned-sun-under-injected-skyAtmosphere ordering bug) with an atmosphere-OFF control; (3) no-imagery globe baseColor — exact pixel vs `globe.baseColor` rgb(31,38,51) (caught the hardcoded WGSL base). Writes `output/ground-view-env/{basecolor,sky,sun-atmo-on,sun-atmo-off}.png` per backend. Run after any change near SkyAtmosphere, Sun, the env-command injection (SceneRenderer.js), or the globe first-pass base color. |
| `probe-ground-atmosphere.mjs` | Globe ground-atmosphere drape (the inscatter-LUT FOG-drape consumer): groundAtmosphere ON vs OFF with skyAtmosphere hidden, non-black + ON/OFF-diff pixel gates; also asserts retired `FeatureRendererKey` 29 stays `undefined`. The LUT bake is still alive even though the SKY shader's LUT consumption is gated off (Batch 247) — this probe is the LUT's live regression guard. |
| `probe-limb-halo-width.mjs` | **SkyAtmosphere shell limb-width gate + ground-atmosphere drape limb diagnostic (Batch 327; re-validated Batch 513 NEW-GLOBE-DRAPE-LIMB-CLOSEOUT), webgl-vs-webgpu.** GATE: globe.show=false + drape off + pure-black space isolates the shell — measures the median blue rim-band width at the disk L/R edges, asserts \|Δ\| ≤ 6 px (Batch 513: WebGL 14 px vs WebGPU 16 px). This scene is the ONLY default-ish framing where the disk interior isn't globe-covered, so it guards the through-planet extinction march in `SkyAtmosphere.wgsl::skyColorForRay`/`computeScattering` (the pre-513 earth-surface ray clip flooded the interior solid blue and truncated the ~10 px limb extinction tail — masked before 2026-06-25 by the skybox-over-atmosphere draw-order bug). DIAGNOSTIC (report-only): globe + drape ON, same measurement (Batch 513: 1 px vs 1 px, delta 0 — the drape band is at parity). Run after touching `SkyAtmosphere.wgsl` scattering/ray math or the sky draw order. |
| `probe-sky-aureole-anchor.mjs` | **C12-31 acceptance — is the sky's bright lobe anchored to the SUN or to the VIEW? webgl+webgpu, hard exit codes.** ⚠ Authored 2026-08-01 by a no-browser worker; the FIRST RUN IS PART OF REVIEW, not a regression check. Ground observer at a pinned clock, pitched +32°, with skyBox/starField/sun/moon/fog/bloom/FXAA/HDR all OFF so the atmosphere shell is the only source (`C12-18`/`C12-19` own the direct-Sun radiance and halo lanes). Four lanes: **L1** heading sweep (toward-sun / ±60° / anti-sun) — the toward-sun frame must out-brighten anti-sun by ≥1.25× and must be the brightest of the four; the defect renders all four within a few percent because the Mie forward peak follows the VIEW. **L2** lobe displacement — the luminance⁴-weighted horizontal centroid must sit on the sun's side of centre and FLIP SIDES when the ±60° offset flips; a view-locked lobe is centred in both, so the sign test is the discriminator, not the magnitude. **L3** after sunset (sun ~15° below the horizon) — mean sky ≤15% of the daytime toward-sun mean and no pixel above luminance 40; this is the maintainer's screenshot condition. **L4** `scene.context.rendererType` must equal the requested backend. Uses the canonical same-task capture (enforced offline by `sky-light-direction.spec.mjs`). Env: `AUREOLE_DAY_TIME`, `AUREOLE_NIGHT_TIME`, `AUREOLE_BACKENDS`. Companion pure spec: `sky-light-direction.spec.mjs` (`node --test`, 17/17). |
| `probe-confirm-inspector-sky.mjs` | **Cross-backend ground-view sky comparison.** `RENDERER=webgl\|webgpu` + `CLOUDS=on\|off`, applies a 650 m ground config (`skyAtmosphere.show`), compositor `page.screenshot` (NOT toDataURL), asserts capture-time camera height = 650 m, measures **upper-center sky mean RGB**. Surfaced BUG-WEBGPU-SKY-GROUNDVIEW-HIGH-ELEVATION-BLACK: WebGPU upper sky `(1,1,1)` black vs WebGL `(75,123,176)` blue, identical with clouds on/off. **The harness template for the deferred sky-shell-coverage fix** — extend it to sample multiple elevations (the existing `probe-ground-view-env` gate only samples the horizon band and is blind to the zenith blackness). |
| `probe-weather-inspector.mjs` | End-to-end gate for the `WebGPU Weather Inspector` gallery demo: boots the gallery `.html` standalone (see the gallery-demo boot recipe under Cross-backend / Sandcastle), drives real DOM sliders + a preset button, compositor-screenshots, asserts the panel builds + Coverage drives the deck + a preset refreshes the UI + 0 errors. |
| `probe-weather-presets.mjs` | **Standards-keyed preset sweep (Batch 405).** Clicks all 8 METAR/WMO presets (SKC/FEW/SCT/BKN/OVC/Ns/Cb/Ci) and verifies the deck-wedge **luminance okta-ladder** holds (clear/sparse > broken > overcast/storm) + clear-vs-overcast and few-vs-storm whole-frame diffs. NOTE the metric is luminance, not a "bright cloud %": heavy decks render DARK grey under their own dim light, so a brightness ladder separates the okta scale; a whitish-pixel count misses the storm decks. |
| `probe-cloud-diagonal.mjs` | **Regression guard for the Batch 406 half-screen-clouds fix (oversized fullscreen triangle).** OVC St ground view; the pre-fix bug rasterized only the lower-left half, so the deck filled bottom-LEFT and bottom-RIGHT was ~0. Asserts the deck is **left-right symmetric** (bottom-left ≈ bottom-right, both > 50%) → no TL→BR diagonal. The deck legitimately thins toward the zenith (thin deck, short straight-up path) — that's NOT the bug; the regression signature is the bottom-half left/right asymmetry. |
| `probe-cloud-dials.mjs` | **Batch 407 struct-growth dials wiring + byte-identity.** Drives `globe.cloud{PuffSize,Exposure,MsDecay*}`: asserts explicit-defaults == undefined (diff 0, byte-identical), reset == default (diff 0), exposure + puff-size change the render. (Exposure's mean-luminance move is tiny — the deck is near the Reinhard knee — so it asserts a whole-frame DIFF, not a brightness direction.) |
| `probe-cloud-genus.mjs` | **Batch 408 V11 per-genus types.** Drives `globe.cloudType`: CUMULUS == default (byte-identical), CIRRUS renders a thinner deck (~0.21× density scale), CIRRUS + Cb substantially change the render, STRATUS differs. Raises coverage to 0.8 first so the per-genus density scale reads; the upward demo camera compresses the vertical (towering) structure, so density-scale is the dominant visible lever — a side view would show the tower/slab shape better. |
| `probe-weather-seam-poles.mjs` | **C13-07 pixel gate** for the dateline/pole weather-map seam. WebGL load-sanity arm + WebGPU lanes at 250 km (the volumetric cloud patch is camera-local; orbit altitudes fade it — C13-29): D-eq puts the camera ON the seam at 0.7°N where the CPU-twin map is cloudy on BOTH sides (west 0.935 / east 0.882), so the frame is its own control — hemisphere-brightness ratio ≤3× and the meridian's column step must not be an outlier vs the frame's own p95; N/S pole lanes use 12 annulus SECTOR MEANS (puff-noise-immune) for the pinwheel spoke signature plus a center NaN-cluster check for the `atan2(0,0)` guard. Per-view LOCAL-NOON clock (a fixed UTC time reads night-side clouds as absent) and a discarded warm-up capture (async pipeline prewarm under-renders the first view — C13-40). **PINNED at Batch 855** under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE` — see the `lib/weather-probe-pinning.mjs` row for the P1-P8 pin set and the read-back/determinism-control contract. It was classified SUSCEPTIBLE on a DIFFERENT axis from the rest of the fleet, and deserves credit for what it had already closed (imagery removed, dark base colour, sky/sun/moon/skyBox off, a per-view solar-noon clock, fused render+read, a real non-vacuity gate). What stayed open: `useDefaultRenderLoop` was left true and every settle frame was `s.render()` with NO argument, which `Scene.js` fills with `JulianDate.now()` — so setting `clock.currentTime` never reached the frame and the deck advected at the 15.0 m/s default wind through all 120 settle frames, directly moving both scored quantities (both are fine-grained SPATIAL statistics); the `cloudQuality` 64 tier path's temporal accumulation low-pass filters exactly the adjacent-column step D1 scores, which is a false-GREEN direction; and terrain was still streamed (no `offline`, no forced `EllipsoidTerrainProvider`). Slot 64 (`weatherMapEnabled`) is required to read 1: this probe drives the PROCEDURAL map via `cloudWeatherMap = true` with no provider, so `weatherEnabled = config.cloudWeatherMap === true` is the whole condition — if it reads 0 the seam under test is not in the frame. Its determinism control repeats the dateline view (on its ~819 adjacent column means) and the north-pole view (on its 12 azimuthal sector means); the south-pole lane is not repeated because it uses the identical capture path the north-pole control validates. **Exit codes: 0 PASS \| 1 real product FAIL \| 2 exception \| 3 STRUCTURAL** (a pin did not take, the frame was too clear to certify, or the probe could not reproduce its own capture — acceptance INCOMPLETE, neither green nor red). Evidence: `output/weather-seam-poles/`. **Gate-B acceptance (Batch 860): PASS 3/3 under the pin** — which is what DISCHARGED the hold on C13-07's promotion: its pixel evidence was one of the five false-green-susceptible probes, the susceptibility was real, and the verdict survived it. **The pre-pinning numbers below are NO LONGER BASELINES** (stopping the wind, escaping the tier path, fixing the render clock and disabling ground atmosphere/fog all move absolute luminance) — retained only as the historical pre-pin record: verified green 2026-08-01 at halves 52.3/52.9, meridian step 0.6 vs p95 1.9, pole maxDev 9.4/65.0. |
| `probe-weather-regional-tails.mjs` | **C13-08 rendered antimeridian + WebGL regression tails (2026-08-02, GREEN on rebuilt Edge; ten PNGs reviewed).** Playwright intercepts a real `EdrWeatherSource` request with cyclic CRS84 CoverageJSON (`170,175,180,-175,-170`) rather than supplying bounds manually, then hard-gates the parser-derived `170..190°` field and regional `getPackStats()` in the same page evaluation as every capture. WebGPU uses local-noon, 250 km nadir controls at 178°E, 178°W, the seam, and a far view: both seam sides show the uniform observed field, the centre has no wall, and the far view is byte-identical to the no-provider procedural fill. WebGL explicitly packs and attaches the same provider to an enabled volumetric-mode `CloudCollection`; its non-vacuous legacy billboard control is byte-identical and `requestVolumetricClouds` remains unused. The accepted run has zero device/console/page errors. Report and captures: `output/weather-regional-tails/manifest.json` and its sibling PNGs. Companion pure policy/fixture/mutation lane: `weather-regional-tails.spec.mjs` (10/10). |
| `probe-cloud-shadows-polar.mjs` | **C13-06 high-latitude cast-shadow gate. PINNED at Batch 861+ under `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`.** 82°N oblique view, midsummer low sun, `volumetric.cloudCastShadows` ON/OFF pair; the ground band (lower 40% of frame) must darken with shadows ON by `off.mean - on.mean > 0.5`. Pre-fix the shadow pass projected the footprint on a 6378137 m SPHERE (21.4 km radial error at the pole — eight deck thicknesses) and marched empty space, so the pair was identical. NOTE the enable knob is `defaultCloudCollection.volumetric.cloudCastShadows` — a bare `globe.cloudCastShadows` silently no-ops (this bit the first orchestrator run). **WHY IT WAS PINNED.** The Batch-855 remediation was scoped by the `probe-weather-*` filename glob rather than by instrument shape, so this probe was missed despite being the same shape: it scored an ABSOLUTE band difference across two captures seconds apart with the OFF leg always LAST, on a NETWORK globe (no `offline`, so Ion world imagery + world terrain streamed straight into the scored band), rendering with bare `s.render()` (`Scene.js` substitutes `JulianDate.now()`; `requestRenderMode` did NOT save it, because the pinned 2026-06-21 date and wall-clock now differ by ~46 days, far beyond `maximumRenderTimeChange = 0`), at the default 15 m/s wind and the default `cloudQuality` 64 tier path (temporal + jitter + half-res, all frame-index inputs). It now consumes `lib/weather-probe-pinning.mjs` for P1–P8 + P10 with full read-back, orders its legs **onA → off → onB** so the ON bracket bounds every drift across the interval the scored difference spans (tolerance 0.1, one fifth of the 0.5 bar), and declares `cloudCastShadows` via `subjectDials` — the one dial it toggles — while asserting it per leg itself. **The 0.5 threshold is UNCHANGED; the additions are STRUCTURAL tiers only.** **Exit codes: 0 PASS \| 1 real product FAIL \| 2 watchdog or exception \| 3 STRUCTURAL.** **The recorded pre-pinning figure (ON 23.6 / OFF 60.8, delta 37.2, 2026-08-01) is NOT a baseline for the pinned probe** — removing imagery, stopping the wind, escaping the tier path and fixing the render clock all move the absolute band means. Evidence: `output/cloud-shadows/`. |
| `weather-map-seam.spec.mjs` (`node --test`, no browser) | **C13-07 dateline/pole-safe global weather-map contract.** Pure-Node; the ONLY oracle for the weather-map seam that does not need a GPU. Pins (a) the texel-centre ↔ lon/lat convention shared by `Scene/Weather/WeatherMapSeam.ts`, both producers, and `ProceduralClouds.wgsl`::`worldToWeatherUV`; (b) exact longitude periodicity of the procedural fBM, with the pre-fix aperiodic fBM retained inline as a **defect oracle** so the test cannot go inert; (c) single-valued poles for both producers; (d) exact byte identity of the polar low-pass below 59° latitude (feature preservation); (e) circularity of that low-pass; (f) textual guards on the three GPU-side halves a CPU-only run cannot execute — the weather sampler's `addressModeU: "repeat"` / `addressModeV: "clamp-to-edge"`, the four `weatherTexBounds` floats, and the WGSL `atan2(0,0)` spin-axis guard. Run it on any change to the cloud weather path. Uses `lib/engine-ts-resolver.mjs` to import non-leaf engine TypeScript (engine `.ts` files reference each other with `.js` specifiers, which Node's type stripping does not remap). |
| `weather-field-bounds.spec.mjs` (`node --test`, no browser) | **C13-08 `WeatherField` bounds / no-data / regional-packer contract.** Pure-Node companion to `weather-map-seam.spec.mjs`; the CPU twin for everything C13-08 decided in `Scene/Weather/WeatherFieldGrid.ts`. Pins (a) the SOURCE-GRID coordinate reference — node-centred by default, cell-centred when declared — including the exact `s*(n-1)` vs `s*n-0.5` expressions and the half-cell offset between them; (b) antimeridian-aware longitude spans and the wrap-awareness rule (`weatherFieldWrapsLongitude` is true ONLY for a cell-registered full-circle field, the one case where the out-of-range tap is reachable); (c) bit-exact identity of the global texel-UV→field-UV mapping, which is what keeps the global path byte-identical; (d) regional placement, including an antimeridian-STRADDLING rectangle whose ramp must increase eastward THROUGH the seam and pack identically whether east is written as `-170°` or `190°`; (e) no-data — NaN holes, a declared `noDataValue` sentinel, `0` staying an OBSERVATION of clear, procedural vs constant fill, option-over-field precedence, and non-bleeding renormalization at a data edge; (f) provider-side contract — CoverageJSON derives bounds from `domain.axes` (with the committed `/mock-edr` + `/mock-wcs` fixtures asserted to still derive EXACTLY the global rectangle, which is what keeps those probes unchanged) and parses `null` as no-data, METAR's out-of-radius cells are no-data while an SKC station is an observed clear; (g) the renderer must KEEP packing global `weatherTexBounds` — a regional bounds uniform would tile the region across the planet. Carries the pre-C13-08 packer inline as a **byte-identity oracle AND a defect oracle** (the same function is shown stretching a regional field over the whole planet), so neither claim can go inert. |
| `cloud-genus-morphology.spec.mjs` (`node --test`, no browser) | **C13-16 per-genus cloud MORPHOLOGY contract (Batch 826, 21/21).** The CPU twin (`lib/cloud-genus-morphology-model.mjs`) IMPORTS the shipped `Scene/CloudTypeProfile.js` table instead of restating it, so the spec cannot drift green. Metrics are STRUCTURAL, never band means (the campaign's recorded trap): correlation length along-wind ÷ across-wind must recover the authored aspect (cirrus 8.10 vs 9, cirrostratus 4.65 vs 5, cirrocumulus 1.95 vs 2) and a top-vs-base cross-correlation must recover the authored fallstreak shear (0.900/0.360/0.140 vs 0.9/0.35/0.15). Byte-neutrality uses `assert.equal` with no tolerances (identity row exactly `0/1/0`, phase delta exactly 0, factor exactly 1, erosion weight exactly `fround(1 - h)`). Falsifiability was RUN, not asserted: flattening the shipped cirrus row turns 5 tests red and deleting `/ aspect` from the WGSL turns the wiring test red. Run it after touching `CloudTypeProfile.js`, `ProceduralClouds.wgsl`'s `genusFibreFactor` / `genusErosionHeightWeight` / `genusForwardG`, or the 168-171 `CloudUniforms` row. **Edge acceptance is OWED** — see the C13-16 orchestrator checklist in `QUEUE_2026-07-23_CAMPAIGN13.md`; the row is PARTIAL and its canonical per-region MIXTURES half is still blocked on `C13-14`/`C13-15`. |
| `probe-cloud-genus-morphology.mjs` | **C13-16 browser acceptance for the per-genus morphology slice (Batch 830; probe repaired Batch 836; STILL NO PRODUCT VERDICT).** Six gates, WebGPU-only: **A UNIFORMS** (the three early returns are provably TAKEN at the default genus, read off the SHIPPED artifacts — the live `CloudTypeProfile.js` table must hand CUMULUS exactly `(0, 1, 0)` and phase delta exactly 0, and slots 168..171 of the renderer's own packed `uniformData` must read exactly `[0, 1, 0, 0]`; a CIRRUS non-identity control makes slot 171 reading 0 proof of an early return rather than vacuous), **B NEUTRAL** (exactly 0 changed pixels against a pre-change baseline — not a small diff), **C DIRECTION** (autocorrelation half-length ALONG the projected wind ÷ ACROSS it, on the clouds-on-minus-off CONTRIBUTION field — **no band mean, no whole-frame mean, no mean difference anywhere**, that is the campaign's recorded trap), **D WIND** (rotate the wind 90° and require the measured argmax axis to follow — a fixed diagonal texture artifact keeps its argmax and fails), **E GRAIN** (cirrus > cirrostratus > cirrocumulus), **F CLEAN**. Camera at lon 90 / lat 0 is load-bearing: the WGSL maps wind to ECEF +X and +Z, so only there are BOTH candidate axes surface-tangent and un-foreshortened to a nadir camera. Checklist items 4 and 8 are human-verdict — the probe CAPTURES those views and invents no scalar; item 10 is honoured by OMISSION (no timing lane, because a timing claim needs the mandatory interleaved-A/B protocol). **STRUCTURAL (exit 3) conditions:** a genus rendering too few contribution pixels to autocorrelate, a degenerate projected wind azimuth on screen, or a correlation that never decorrelates within the sample window — each leg says so rather than scoring. Exit codes: 0 all gates decided+passed, 1 real FAIL, 2 watchdog (420 s) or exception, 3 no FAIL but a gate had no subject. **Current state: no verdict either way.** Its first run reported `executeCalls=0 / initialized=false / pipelineReady=false`, which impersonates a broken renderer but was the probe never calling its own `configure()` before `awaitProceduralReady` — `configure()` is what ENABLES the volumetric renderer and every working cloud probe (`probe-cloud-banding`, `probe-cloud-tour`) calls it FIRST. Fixed Batch 836; the run now exceeds the 420 s watchdog at `cloudQuality: 96`. Tuning owed (the structural legs measure DIRECTION and do not need 96 march steps; the legs can also be split across runs). Nothing from it is evidence for or against C13-16. |
| `fog-cheap-coverage-gate.spec.mjs` (`node --test`, no browser) | **`CLOUD-LOW-COVERAGE-CUTOFF` fog cheap-path arm (Batch 832, 15 tests).** Requires Node ≥ 22.18 (the model imports a `.ts` module and relies on built-in type stripping; on 22.6–22.17 add `--experimental-strip-types`). Executes the REAL `WebGPUCloudDensityDomain.ts` and the REAL `VolumetricFog.wgsl` text. **Read this one before touching any coverage gate: it pins the finding that the obvious one-line fix is WORSE than doing nothing.** Routing the fog's cheap cloud shadow through `cloudEffectiveCoverage` while leaving the sample alone measures 28.2 pp error against the 23.9 pp of the historical raw gate, because the fog builds its own local 3-octave `fbm3d` (mean 0.5000 / σ 0.1206) rather than sampling the baked shape channel (mean 0.4307 / σ 0.0896) — a coverage threshold only transfers between fields that share a distribution. The shipped fix standardises the fog SAMPLE onto the baked field's first two moments and then applies the shared response unmodified (23.9 pp → 1.5 pp, contract 2 pp). Four-way in-file MUTATION group — historical gate 23.9 pp, normalisation deleted 28.2 pp, response reverted 21.6 pp, σ ratio flattened 8.2 pp — all above the 5 pp mutant floor, **so the historical gate is pinned as its own mutant and nobody can "simplify" back to it**. Every metric is banded (threshold exceedance) or point (the gate at one order statistic), never a field mean. Run it after touching `VolumetricFog.wgsl`'s `sampleCloudShadow`, `WebGPUCloudDensityDomain.ts`, or `WebGPUVolumetricFogResources`' module composition. **Edge acceptance OWED:** clouds ON at coverage 0.15 / 0.35 / 0.55 with the shadowed ground fraction tracking the visible deck, plus a clouds-OFF byte-identical control. |
| [lib/weather-probe-pinning.mjs](../Tools/visual-regression/lib/weather-probe-pinning.mjs) (shared module — launches no browser of its own) | **The single enforceable home for the weather fleet's determinism pinning (Batch 855).** `probe-weather-channels.mjs` flipped GREEN/RED/RED/RED/RED on ONE build; the audit (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`, `DEFERRED_WORK.md`) found the same instrument shape in five more probes, so the fix landed ONCE rather than being copied five times. `installWeatherPinHarnessOnPage(page)` injects the in-page half via `page.addInitScript`, which **drops the surrounding module closure** — the injected function may not reference anything outside its own body, and Cesium is passed in per call rather than captured. **THE PIN SET (P1-P8; the numbering matches `probe-weather-channels.mjs`, which remains the reference implementation).** *P1 OFFLINE GLOBE* — `&offline=true` in the URL (the caller's job; `CesiumViewerStartupOptions.js:18-42` hands every other query shape Cesium World Terrain + the Ion world-imagery base layer) plus `imageryLayers.removeAll()` and a forced `EllipsoidTerrainProvider`. *P2 ONE DRIVER* — `useDefaultRenderLoop=false`, `requestRenderMode=false`, `clock.shouldAnimate=false`, `clock.multiplier=0`, and every render through `renderAt(julianDate)` with an EXPLICIT date: a bare `Scene.render()` substitutes `JulianDate.now()`, so a probe that leaves the widget rAF loop running advances the cloud `time` uniform off the wall clock **no matter what it sets on `viewer.clock`**. *P3 ZERO WIND* — `cloudWindSpeed = 0` (default 15.0, `CloudVolumetrics.js:83`); `cloud.time` reaches the density field ONLY as `windDirection * windSpeed * time`, so at speed 0 the clock is provably inert on cloud SHAPE, which is what makes a per-location clock safe. *P4 ESCAPE TIER* — `cloudQuality = 32`; any value `!== 64` takes `resolveCloudPreset`'s power-user escape hatch and forces `temporalEnabled`/`jitterEnabled`/`lightConeSampling` false, `noiseSource: LIVE`, `renderResScale 1.0`. The DEFAULT 64 is the TIER path, whose temporal accumulation + jitter + half-res are all **frame-index** inputs to the march. *P5 APPLIED GATE* — `awaitWeatherApplied` polls until the provider has data AND the cache uploaded THAT version AND the shader uniform enables the map; never a flat sleep (a sleep leaves the deck rendering from global coverage — dense everywhere — an independent route to a saturated sample). *P6 FIXED CLOCK* — `localNoonAt` gives each longitude its own local mean noon, so at a fixed latitude solar elevation is equal everywhere and illumination cannot masquerade as a weather-field effect; safe only because of P3. *P7 SAME-TASK* — `capture()` is ASYNC and MUST be awaited. It runs the canonical fused snapshot from [lib/same-task-capture.mjs](../Tools/visual-regression/lib/same-task-capture.mjs): render → `canvas.toDataURL('image/png')` synchronously in ONE task, snapshot the shader-visible slots before the first await, then decode that immutable PNG for the metrics — so the documentary PNG and the metric bytes are the SAME bytes and no read ever touches a presented (and therefore WebGPU-invalidated) surface. The retired `drawImage` → `getImageData` reader could return an all-zero frame with no way to say so; **figures banked from it are not comparable across the change — read the module's `WHAT THE CAPTURE CHANGE DOES TO THE NUMBERS` block for which ones survive and which do not.** `settle()` is unchanged: a WALL-CLOCK budget driven by `setTimeout(0)` yields, never a frame count (a cold pipeline variant has measured ~2674 ms to compile). *P8 NO OTHER LIGHT* — optional and caller-selected; `probe-weather-ingest.mjs` deliberately keeps its sky because its metric is built around a lit one. **READ-BACK IS WHAT MAKES A PIN A PIN.** Requesting a setting is not establishing it. Every pin is read back — from the live scene for the scene pins, and from the packed cloud uniform buffer (`context._cloudCache.uniformData`) for the shader-visible ones: `WEATHER_PIN_SLOTS` = **35 time / 44 maxSteps / 64 weatherEnabled / 74 qualityFlags / 107 channelStrength**, with `FORBIDDEN_QUALITY_BITS` (NOISE_BAKED 0, HALF_RES 1, TEMPORAL 2, JITTER 3, LIGHT_CONE 10) required CLEAR. `collectPinStructural()` turns a pin that did not take into **STRUCTURAL (exit 3)**, never into a product verdict — a probe that is not measuring the configuration it documents certifies nothing. **DETERMINISM-CONTROL CONVENTION (`collectRepeatStructural()`).** Two captures of ONE configuration must agree per sample (`perSample`), on the mean (`mean`), and — where the probe SCORES a sum of per-sample deltas — on that same sum (`absSum`, so the control bounds the quantity the assertion actually reads); the cloud `time` uniform (slot 35) must additionally read identically at every sample in both legs. **The repeat leg BRACKETS the scored gap rather than sitting beside it:** `metar` runs `ch1A → ch0 → ch1B` and `ingest` runs `hiA → lo → hiB`, so the control spans the same wall-clock gap AND the same dial/source changes the assertion reads across — and `ingest`'s swap BACK additionally proves the deck is a function of the CURRENT source rather than of how many sources have been seen. A back-to-back control taken before the gated leg only proves stability across a gap the gate never reads. Leg B also typically reaches its first sample from leg A's LAST pose, so the control tests independence from view history — which is where the recorded `channels` flip lived. **NOT A LICENCE TO LOOSEN.** Nothing here widens, lowers or removes an assertion; the control is an ADDITIONAL gate whose tolerances sit strictly inside the smallest margin the calling probe scores. **Numbers recorded BEFORE pinning are not baselines** — P1/P3/P4/P6 all move absolute levels. Every scored gate in the fleet is relative and survives, with ONE exception: `probe-weather-ingest.mjs` gate 4 (`deckHi > 5`) is ABSOLUTE, and if it now fails that is a finding to investigate, not a licence to lower the bar. **P9 HEADROOM (Batch 861)** — `collectHeadroomStructural` / `selectPartialCoverageBand` / `COVERAGE_HEADROOM_BAND`: a gate that scores a DIFFERENCE of a bounded metric must show every scored location's BASELINE leg sitting away from both bounds, read from the leg that was actually scored. **P10 READINESS NON-VACUITY (Batch 861+)** — the enforcement layer must gate its OWN read-back. `awaitGlobeReady` spends its 90 s budget and then RETURNS `{ binnedGlobeCommands: 0, firstBinnedMs: null }` when the globe never bins a `Pass.GLOBE` command; it does not throw. Every pinned probe merely PRINTED that number inside a `console.log` template and `collectPinStructural` had no parameter for it, so a run in which the WebGPU globe pipeline was still cooking past the budget scored a product verdict (RED) over frames that were entirely the clear colour — the number that would have explained it computed, logged, and gated by nothing. `collectGlobeReadinessStructural` is the enforcement and **`globeReadiness` is now a REQUIRED option of `collectPinStructural`**: omitting it, passing an empty map, a non-finite count, a zero count, or a `binned > 0` report with a null `firstBinnedMs` are all STRUCTURAL. Making absence itself STRUCTURAL is the point — a read-back a caller can forget to hand in is not enforcement. It reads `binnedGlobeCommands`, never `elapsedMs` (slow is not blind), which is the mutation `weather-probe-headroom.spec.mjs` M10 exists to reject; `env-background-clear.spec.mjs` test E5 already codified the same rule for the sibling globe lane and named the race ("`tilesLoaded` is TRUE while the WebGPU globe pipeline is still cooking"). **`subjectDials`** — a probe whose SUBJECT is one of the determinism dials declares it (`probe-cloud-shadows-polar.mjs` declares `cloudCastShadows`) and asserts it per leg itself; only `EXEMPTIBLE_SUBJECT_DIALS` = `cloudCastShadows`/`cloudContributesIBL` may be declared, because wind and the tier escape are what make two consecutive captures comparable at all, and an undeclarable name is STRUCTURAL rather than silently ignored. All of P9/P10 plus the six-probe source anchors are pinned by `weather-probe-headroom.spec.mjs` (every pin, the P9 headroom rule and the P10 readiness rule each carry at least one adversarial mutant that must red the spec; the counts move as the fleet grows, so the guarantee is stated here rather than a number that drifts). |
| `probe-weather-edr-mock.mjs` | **Mock-EDR offline ingest gate (Batch 424; PINNED Batch 855), WebGPU-only.** Proves the FULL EDR chain — fetch → CoverageJSON parse → packer → `weatherTex` → clouds — without the live network, by pointing an `EdrWeatherSource` at the dev server's `/mock-edr` route (committed fixture `fixtures/edr-cube-tcc.json`: a 12×6 TCDC grid ramping clear-NW → overcast-SE with a clear "eye" in the east). Flies a 250 km nadir camera across nine longitudes west→east and counts bright pixels per location. Gates: **1 URL** (`buildUrl()` targets the mock endpoint), **2 FETCHED** (`hasData`, `version > 0`, no `lastError` — i.e. no fallback-to-procedural), **3 PATTERN** (`east - west >= 0.03`), **4 CLEAN** (0 new device/console errors), plus a BACKEND hard-fail on `scene.context.rendererType === "webgpu"` (volumetric clouds are WebGPU-only, so scoring a WebGL frame as a WebGPU pass is a false green). **Why it was pinned:** its metric was a raw `max(r,g,b) > 120` count and it loaded no `offline` flag, so lit Ion imagery cleared 120 and was counted as cloud — and the contamination is **ORDERED**: `west` (lon −160) is visited FIRST, ~7 s after setup, and `east` (lon 160) LAST, nine camera jumps later against a far warmer tile cache, so streamed imagery biases `east - west` UPWARD, the exact direction gate 3 scores. Determinism control: the sweep is captured TWICE back to back (`sweepA`/`sweepB`), tolerances strictly inside gate 3's 0.03 margin. **Exit codes: 0 every gate decided+passed \| 1 real product FAIL \| 2 watchdog or exception \| 3 STRUCTURAL** (a pin did not take, the fixture never reached the GPU, or the probe could not reproduce its own capture — acceptance INCOMPLETE, neither green nor red). Evidence: `output/weather-edr-mock/*.png` + `manifest.json`. **Gate-B acceptance (Batch 860): GREEN 3/3**, and byte-identical run to run in its SCORED values — per-location deltas exactly `0.000`, sweep-mean delta `0.0000`, only wall-clock timings differing — while the pin did NOT flatten the signal it was protecting (`west 0.389 / east 1.000` still separates). That is what acceptance looks like. Pre-pinning `fr:` values are NOT baselines. |
| `probe-weather-wcs.mjs` | **Mock-WCS (OGC API-Coverages / MSC GeoMet) offline ingest gate (Batch 425; PINNED Batch 855), WebGPU-only.** Same chain as `edr-mock` through the SHARED CoverageJSON parser, pointed at `/mock-wcs` (committed fixture `fixtures/wcs-coverage.json`, a 12×6 TCDC grid ramping clear-west → overcast-east). Gates 1 URL / 2 FETCHED / 3 PATTERN (`east - west >= 0.03`) / 4 CLEAN, plus the same WebGPU backend hard-fail. **Why it was pinned:** its capture path was byte-for-byte the same instrument as `edr-mock` — same `>120` count, same nine longitudes, same gate — with the same ORDERED imagery bias in the scored direction, the same 15.0 m/s default wind under bare `s.render()`, the same `cloudQuality` 64 tier path, and the same flat 7 s `hasData` sleep (which says the CPU pack exists, not that the bytes reached the GPU). Determinism control: `sweepA`/`sweepB` back to back, tolerances strictly inside 0.03. **Exit codes: 0 \| 1 FAIL \| 2 watchdog/exception \| 3 STRUCTURAL.** Evidence: `output/weather-wcs/*.png` + `manifest.json`. **Gate-B acceptance (Batch 860): GREEN 3/3.** Pre-pinning `fr:` values are NOT baselines. |
| `probe-weather-metar.mjs` | **Mock-METAR full-RGBA ingest gate (Batch 425; PINNED Batch 855), WebGPU-only. ⚠ RED 3/3 AT HEAD — read `C13-GATE-B-METAR-CHANNELS-NO-EFFECT` in [DEFERRED_WORK.md](DEFERRED_WORK.md) BEFORE diagnosing anything here.** Proves station obs → cloud-group parse → IDW rasterize → packer (R coverage + G genus + B base + A density) → `weatherTex` → clouds against `/mock-metar` (committed `fixtures/metar-stations.json` with SKC / BKN / OVC / CB stations, so the IDW field varies BOTH spatially in R and in G/B/A). Gates: **1 CAPS**, **2 FETCHED**, **3 SPATIAL** (`cloudy(OVC) - clear(SKC) >= 0.05`), **4 CHANNELS** (`sum\|ch1 - ch0\| >= 0.04` across the band — turning G/B/A ON must shift the deck), **5 CLEAN**, plus the WebGPU backend hard-fail. **It was the fleet's worst case — TWO independent false-GREEN paths.** Gate 3's two samples are geographically asymmetric (`clear` lon −120/lat 35 Pacific vs `cloudy` lon 0/lat 35 western Mediterranean + the bright North African coast), so arid land imagery clearing 120 pushed `cloudy - clear` UP, the direction the gate scores. Gate 4 differences two sweeps taken at DIFFERENT wall-clock times, so ANY drift ADDS to the scored sum — arriving tiles, the deck advecting at the 15.0 m/s default wind under wall-clock `time`, and the tier path's temporal/jitter/half-res. Slot 107 is checked PER CAPTURE (1 on the two full-strength sweeps, 0 on the gated one) because gate 4 is meaningless if the strength dial never reached the shader; the control is ordered `ch1A → ch0 → ch1B` so it BRACKETS the gated sweep and spans both strength changes. **Exit codes: 0 \| 1 FAIL \| 2 watchdog/exception \| 3 STRUCTURAL.** Evidence: `output/weather-metar/*.png` + `manifest.json`. **STATE AT HEAD (Batch 860 acceptance): RED 3/3, and the instrument around the failure is demonstrably sound** — the determinism control reads max per-location `0.0000` (tol 0.004), mean `0.0000` (tol 0.002) and summed `\|delta\| 0.0000` against a 0.015 tolerance, scoring THE SAME QUANTITY gate 4 scores against 0.04. Gate 4 measures `sum\|ch1-ch0\| = 0.0019`; gates 1/2/3/5/6 all pass including IDW spatial variation (OVC `1.000` vs SKC `0.000`), so the provider IS fetched, parsed and rasterized. **TWO readings are on file and BOTH survive the evidence** — (A) the previous GREEN was manufactured by the wall-clock drift the pin removed, a conclusion predicted in writing by Batch 855 BEFORE the measurement; (B) five of seven sampled locations sit at exactly `1.000` in both configurations, so the metric has NO HEADROOM and could not see a real channel effect. **The discriminator is one run: re-aim gate 4's seven locations at partial coverage (`ch0` ≈ 0.3-0.7) and re-measure. Explicitly NOT permitted: lowering the 0.04 bar** — it was authored against an expected channel effect, and fitting it to 0.0019 produces a gate that cannot fail. Do NOT record this as an engine defect OR as an instrument defect until the discriminator runs; `C13-GATE-B` cannot close while it stands. Pre-pinning `ch1 fr:` / `ch0 fr:` values are NOT baselines. |
| `probe-weather-ingest.mjs` | **Weather ingest MVP end-to-end gate (Phase 0/1; PINNED Batch 855), WebGPU-only.** Proves the data-driven path — a `WeatherProvider` + `WeatherSource` emits a real `WeatherField` → `WeatherTexPacker` bakes the C2-16 weather-map texture → the raymarcher's `effectiveCoverage` reads R → the deck reflects the data, and the map AUTO-ENABLES once data arrives — using `SyntheticWeatherSource` (deterministic, no network). Gates: **1 API** exports, **2 EDR URL** well-formed, **3 FETCHED**, **4 DECK** (`deckHi > 5`), **5 CLEARS** (`deckLo < deckHi - 5`), **6 CLEAN**, plus the WebGPU backend hard-fail. **Why it was pinned — its dominant contaminant was the CLOCK, not imagery:** it never disabled sky/sun/atmosphere and never set the clock, so with every render a bare `s.render()` the solar elevation differed on every run and drifted DURING each run across a hard `L > 90` classifier bar. Secondary: the deck advected at 15.0 m/s, the tier path was live, and at 650 m with a +16° pitch and a ~23.4° vertical half-FOV the bottom of the sampled band (to `y = 0.82h`) sits at or below the horizon, where sunlit terrain imagery is exactly what the whitish/grey classifier looks for — with no globe base colour set. **The sky is DELIBERATELY left on** (unlike the nadir probes): the metric excludes blue sky explicitly (`b > r + 25 && b > 120`) and counts what is left, so blanking it would change what the classifier means; determinism comes from the fixed clock instead, while everything BELOW the horizon that could be mistaken for deck is removed (imagery, streamed terrain, ground atmosphere, fog, and the default globe colour → a dark base whose L is far under 90). **Recorded residual metric weakness, not worked around:** near the horizon the atmosphere whitens and low-altitude sky can classify as deck — present in BOTH legs, so not a false-green path for the DIFFERENCE gate 5, but a constant offset on gate 4's absolute bar. Control ordered `hiA → lo → hiB`. **Exit codes: 0 \| 1 FAIL \| 2 watchdog/exception \| 3 STRUCTURAL.** Evidence: `output/weather-ingest/*.png` + `manifest.json`. **Gate-B acceptance (Batch 860): GREEN 3/3.** Pre-pinning `deck%` values are NOT baselines, and gate 4 is the one absolute gate in the fleet — if it ever fails, investigate; do not lower it. |
| `probe-weather-channels.mjs` | **Weather Phase 3 G/B/A weather-channel gate (Batch 424); PINNED at Batch 852 and THE REFERENCE IMPLEMENTATION of `lib/weather-probe-pinning.mjs`** — read this file first when pinning any new probe, and read the lib row below for the P1–P10 derivation. WebGPU-only. Drives a `SyntheticWeatherSource("rich")` whose R is near-flat (0.85) but whose A varies WEST(thin 0.05)→EAST(dense 0.95), B north→south and G stratus→cumulonimbus, then flies a 250 km nadir camera to nine far-apart longitudes at a fixed latitude with sky/sun/skyBox off and a dark globe and counts bright pixels. Because R is flat, the per-location spread IS the G/B/A response. Gates: **1 DECK** (`hasData`, `version > 0`), **2 PRESENT** (rich mean > 0.02), **3 SPREAD** (rich stddev >= neutral stddev + 0.01), **4 WEST/EAST** (west < east − 0.02), **5 GATED** (`cloudWeatherChannelStrength = 0` collapses the spread toward the neutral control), **6 CLEAN**, plus a WebGPU-backend HARD FAIL (scoring a WebGL frame as a WebGPU pass is a false green). **This is the probe whose five runs of ONE build produced GREEN/RED/RED/RED/RED** and so named `C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE`: it loaded `?renderer=webgpu` with no `offline`, so a `max(r,g,b) > 120` bright-pixel metric counted lit Ion imagery tiles as CLOUD. Its determinism control BRACKETS the scored legs — `richA → neutral → richOff → richB` — so it bounds the instrument across the same interval AND the same dial changes gates 3 and 5 read across; a control taken back-to-back before the gated leg only proves stability across a gap the gate never reads. **Exit codes: 0 PASS \| 1 real product FAIL \| 2 watchdog/exception \| 3 STRUCTURAL** (a pin did not take, globe readiness read zero binned `Pass.GLOBE` commands, or the probe could not reproduce its own capture). **Pre-pinning numbers are NOT baselines.** Source-anchored by `weather-probe-headroom.spec.mjs` (it must import the shared module, hold no private copy of `awaitWeatherApplied`/`awaitGlobeReady`/`localNoon`/`FORBIDDEN_QUALITY_BITS`, keep `offline=true` in its URL, keep the bracket order, and pass `globeReadiness` to `collectPinStructural`). |
| `probe-weather-map.mjs` | **C2-16 weather-map seam gate (Weather Phase 1, the keystone).** WebGPU-only. High nadir view over a wide footprint; a coarse grid of cloud-fraction cells must have LOW stddev with `volumetric.cloudWeatherMap = false` (one global coverage scalar ⇒ uniform sky) and HIGH stddev with it true (regional structure), while OFF still renders clouds (no regression) and ON produces near-zero cells (real clear gaps). Exit codes: 0 PASS \| 1 FAIL (`process.exitCode`); no structural tier. **⚠ NOT PINNED, and susceptible on the recorded fleet axes — do not cite a green from it as determinism-grade evidence.** It loads `?renderer=webgpu` with no `offline` flag (Ion world imagery + world terrain stream into a brightness-derived cloud-fraction metric), renders with bare `s.render()` (which `Scene.js` fills with `JulianDate.now()`), leaves `cloudWindSpeed` at the 15.0 m/s default and `cloudQuality` at the 64 tier path, and has neither a watchdog nor a `finally` around `browser.close()`. Filed under `NEW-PROBE-WEATHER-MAP-UNPINNED` in `DEFERRED_WORK.md`; the repair is mechanical (route it through `lib/weather-probe-pinning.mjs`, exactly as `probe-cloud-shadows-polar.mjs` was). |
| `probe-weather-time.mjs` | **Weather TIME-MODEL logic probe (Phase 2). NO network, NO WebGPU, NO pixels — and DELIBERATELY EXEMPT from the Batch 855 pinning; do not re-pin it.** Drives a deterministic time-varying `SyntheticWeatherSource("drift")` through a `WeatherProvider` and asserts the pure provider logic off the PACKED BYTES + version counter: live `tick` advances the field, a sub-quantum tick does NOT bump `version` (slice unchanged), historical/projected resolve distinct slices, scrubbing back to a fetched slice is an instant LRU cache hit, and a provider with no time mode keeps the legacy "latest" behaviour. **Why the exemption is a PROOF, not an assumption** (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE` classification): it never renders, never reads a pixel and never touches `window.viewer`; it constructs its own provider objects and drives them with EXPLICIT fixed instants (`t0 = Date.UTC(2026,0,1)`, `+6h`, `−9h`, `+18h`) with no wall clock anywhere. The network globe reaches it ONLY as CPU/bandwidth contention against its 300 ms poll budget (60 × 5 ms in `poll()`), whose failure mode is a null buffer — which fails the `h0 != null` guards. **Contention can therefore produce a false RED and never a false GREEN, so its existing GREEN is trustworthy as recorded and no re-run is owed.** Exit: 0 PASS / 1 FAIL (no structural tier — it has no way to be vacuous). |
| `probe-cold-optics-hq.mjs` | **Advanced ice-crystal optics gate (Batch 442), WebGPU-only** — 22 deg + 46 deg dispersed halos, upper tangent arc, and light pillars behind the opt-in `scene.coldOpticsAdvanced`. Three captures on ONE canvas: cold-optics ON/advanced OFF (the legacy parity reference and analysis baseline), advanced ON at ~28 deg sun with a 100 deg FOV so the 46 deg halo fits, and advanced ON at ~6 deg sun for pillars. The radial added-brightness profile of (advanced - legacy) must show TWO peaks whose radius ratio is ~46/22 ~ 2.09, and the low-sun capture must show a vertical added-brightness streak far taller than wide. **VERDICT REPAIRED Batch 861+ (`NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` sweep).** `twoHalos` and `pillarTall` were computed under a literal `// Verdict.` banner, printed, and NEVER GATED — the only exit was `process.exit(errCount === 0 ? 0 : 1)`, so the probe returned a citable green with BOTH claims false as long as no device error fired. That is the stronger form of the class: not a proxy gate, a verdict with no gate. Both are now `pass` conjuncts at their ORIGINAL thresholds (`peaks.length >= 2`; `aspect >= 1.8 && verticalExtentPx >= 20`). **Exit codes: 0 PASS \| 1 real product FAIL \| 2 watchdog or exception \| 3 STRUCTURAL** — the sun must project to a screen point and sit above the horizon in each capture set, `coldOpticsEnabled`/`coldOpticsAdvanced` must READ BACK as driven in all four legs, and the advanced-minus-legacy difference must be non-empty (an A/B in which no pixel moved is a dead toggle, not an absent halo). Outputs: `output/cold-optics-hq-*.png`. |
| `probe-celestial-gates.mjs` | **Campaign-12 celestial gate harness (C12-01 + C12-02); TWO LANES since the C12-G1F2 repair (Batch 859).** Captures the star field on BOTH backends under the exact framing each gate needs and evaluates the second-order metrics from `lib/celestial-metrics.mjs` (the `node --test` trust anchor). Mean luminance is reported but EXPLICITLY non-certifying — a normalized-kernel convolution (mip/bilinear/MSAA/JPEG) moves the mean by zero. **LANE A `orbital-cubemap-parity`** — the historical G1 framing (camera 5.0e7 m along the sun direction, globe/sun/moon/skyAtmosphere/fog OFF, bare star field on black), renamed for what it can actually see: CUBEMAP AND SPRITE PARITY. It was previously LABELLED "the only framing that reaches the C11-176 failure state", which is false in two independent ways — that camera is ~43,600 km up, far above `ATMOSPHERIC_COLUMN_FADE_END = 111 km` (`SkyBrightness.js:60`, applied at `:563`), so `frameState.skyBrightness` is identically 0 and `AtmosphericConditions.js` documents that as the DESIGN (the orbital camera is precisely the one that must NOT dim); and `CubeMapPanorama.js:433` additionally gates the term on `frameState.skyAtmosphereVisible === true`, which this lane turns off. PASS requires, on the default pair: M1 point-source count ratio ≥ 0.90, M2a RMS-contrast ratio in [0.85, 1.15], M2b (P99.9 − P50) ratio in [0.85, 1.15], M3 median chroma ≥ 0.85× WebGL, and **M2e robust sky floor \|gpu − gl\| ≤ one 8-bit code value in linear light** — M2e is described in its own source as "the single most direct discriminator for a veil/pedestal mechanism" and until Batch 859 was computed, written to JSON and **gated by nothing**; it now certifies ABSOLUTELY rather than as a ratio, at `SKY_FLOOR_ABS_TOLERANCE = srgbToLinear(1/255)` ≈ 3.035e-4, a bound DERIVED FROM QUANTIZATION and not from any measured value (do not retune it to whatever a run happens to measure). Each M6 source-split mode (`default` cubemap+sprites / `cubemap-only` / `sprites-only`) must also hold M1 ≥ 0.90, so a one-source regression cannot be masked by the other; a mode where BOTH backends census zero sources is **STRUCTURAL, not FAIL** — 0/0 is an instrument that cannot see its subject. **LANE B `in-column-star-modulation`** — camera INSIDE the atmospheric column (30 km, below `ATMOSPHERIC_COLUMN_FADE_START = 60 km`) on the sunlit side with the sky atmosphere ON, so `skyBrightness` saturates to 1.0 and `skyAtmosphereVisible` is true: both C11-176 preconditions met for the first time. Captured twice with `enableStarBrightnessModulation` OFF then ON; the certifying quantity is the modulation's OWN energy, `mean(OFF) − mean(ON)`, taken WITHIN each backend and only then compared across, so the sky-atmosphere shell cancels and a shell-parity gap can neither masquerade as nor mask a star-modulation gap. The OFF/ON swing doubles as the non-vacuity control (floor `MODULATION_ENGAGED_MIN_ABS_DELTA`, deliberately absolute and equal to the same one-code-value bound — a RELATIVE floor would be star-over-sky and would push the lane structural for reasons unrelated to the term). **REACHABILITY IS NOW ASSERTED ON THE DRIVING VARIABLE:** `framingReached` tests `skyBrightness > 0.5` (`probe-skybox-star-modulation.mjs`'s own predicate), NOT `sunElevationDeg >= 25` — solar elevation merely correlates with sky brightness below 60 km and is fully DECOUPLED from it above 111 km, which is exactly where the old assertion was being evaluated. **Attribution:** `m2a` is a ratio of ratios whose two factors used to be computed and then dropped, making every failure unattributable; `meanLumRatio` is now promoted and `stddevRatio` added, and sky floors print UNROUNDED (the old 3-decimal rounding displayed every legitimate ~3e-4 floor as 0). **Exit codes: 0 PASS \| 1 FAIL (a measurable criterion out of band) \| 2 ERROR (a backend lane did not RUN) \| 3 STRUCTURAL (a lane RAN but could not see its subject — reachability not met, the modulation term never moved a pixel, or both backends censused zero sources in a count mode).** Never report such a lane as 0. `--bracket` runs the separate C12-02 HDR exposure bracket (1×/8×/64×, stitched to a linear-light float image; M4/M5 are DIAGNOSTIC, and `hdr:true` is recorded so bracket evidence is never confused with the SDR G1 lanes). Evidence: `output/celestial-g1.json` / `output/celestial-bracket.json` + `output/celestial-g1-*.png`. Verdict arithmetic is extracted to `lib/celestial-g1-gate.mjs` and pinned browser-free by `celestial-g1-gate.spec.mjs` (`node --test`, **49 tests, 20 adversarial mutants** each rejected as its own named subtest — including all three verdict-doctrine violations and the two that would have hidden this class again: a tolerance fitted to a measurement, and M2e reported-but-not-gated). **⚠ TWO BLINDNESS-SCOPE DEFECTS IN THE BATCH-859 REPAIR ITSELF, found by audit and fixed 2026-08-07 — the same mistake in opposite directions.** (a) **Lane B's non-vacuity control ANDed the two backends** (`abs(glDelta) >= floor && abs(gpuDelta) >= floor`), so a modulation term live on ONE backend and inert on the other — the C11-176 shape verbatim, and the exact defect the lane was rebuilt to catch — was DOWNGRADED from FAIL to STRUCTURAL, under a printed headline that asserts "this is NOT a pass and NOT a defect". Non-vacuity is now **per backend**: BOTH dead is STRUCTURAL, ONE dead is a FAIL named as `in-column-star-modulation:modulationEngaged_on_both_backends`, and `glModulationEngaged` / `gpuModulationEngaged` travel in the printed summary so the failure is attributable. Note the polarity contrast that made this visible: `modeIsBlind` ANDs the two ZERO conditions (correct — blindness needs both sides dead), the modulation control ANDed the two ENGAGED conditions (wrong — either side dead declared blindness). (b) **Lane A's blindness rule was applied only to the SECONDARY count modes, never to the CERTIFYING `default` mode**, whose four criteria all read ratios that go `null` on a zero WebGL denominator — so a doubly-blind default would have produced four confident FALSE criteria and exit 1, a phantom defect over a scene where nothing was censused at all. A doubly-blind certifying mode is now STRUCTURAL and voids the whole lane (`pass` is explicitly `!certifyingModeBlind && …`, because `{}.every(Boolean)` is vacuously true); one-sided blindness on the certifying mode remains a FAIL. This probe is the named instance of `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` — read that entry in [DEFERRED_WORK.md](DEFERRED_WORK.md) before authoring any new reachability boolean, **and note that a reachability rule can also be wrong by SCOPE, not only by variable.** **★ 2026-08-07 (CO-3) — LANE A RE-SCOPED FOR DR-01, AND A THIRD MODE `--g2` ADDED.** Every Lane-A criterion above that reads an M1 COUNT is superseded: Batch 833 (C12-11 / DR-01) made `SkyBox.defaultVariant = TYCHO_T5_DIFFUSE`, whose faces census 0 resolved sources BY CONSTRUCTION, and the sprite catalogue peaks below the census floor in this framing (code 36 against ~code 61) — so all three modes read 0/0 and the lane went STRUCTURAL over a healthy scene. **The census floor was NOT lowered** (prohibited: it would put candidates back inside the diffuse band's 8-bit range). Instead each mode now certifies what it owns after the seam, via `MODE_ROLE` in `lib/celestial-g1-gate.mjs`: `cubemap-only` asserts the DR-01 seam itself (`cubemapOnly_dr01_resolvedSources_le_2` — **the zero is now the assertion, not the blindness**) with a not-blank positive control so a black frame cannot satisfy it; `sprites-only` certifies on lit-extent parity, `maxChannelDelta <= 2`, `differingFraction <= 5e-4` and a chroma ratio re-pointed to the brightest SPRITE pixels; `default` keeps M2a/M2b/M2e and gains lit-extent parity. Blindness routes on `modeIsBlank` (lit pixels, bar exactly zero), not `modeIsBlind` (the count), which is retained and pinned as the superseded predicate. New metrics live in `lib/celestial-source-split.mjs`. **`--g2` (NEW) runs the G2 white-blobs gate** — three sub-lanes per backend, and it must PASS IDENTICALLY ON BOTH (shared code; a WebGPU-only pass is a FAIL): `psf` (TELESCOPE framing `fovX = 6 deg`, HDR bracket, M4 at the aim point → `psf_rangeExtended`, `psf_ratio1e3_ge_4`, `psf_slopeInner_in_band`, `psf_slopeOuter_in_band`, `psf_slopes_agree`); `magnitude` (default framing, 1x HDR, M5 cross-matched against the SHIPPED `BrightStarCatalog` → `mag_renderedRange_ge_15`, `mag_spearman_ge_0_90`, `mag_clippedPixels_le_25`); and `glare` (C12-27's own acceptance criterion → `glare_farField_byteIdentical`, `glare_nearField_energyDrop_ge_bound`, `glare_nearField_changedPixels_ge_bound`, `glare_nearField_noPixelBrightened`), plus a cross-backend `psf_ratio1e3_parity`. Both glare legs sit on the SUNLIT side so `eclipseState.sunVisibleFraction` is 1 and the veil has a source; an **A/A control** proves the byte-identity claim is falsifiable before it is made. **⚠ THE BRACKET STITCH IS NOW LINEARIZED:** the old `L = (v/255)/f` ignored `czm_pbrNeutralTonemapping` + `czm_inverseGamma`, which squares the faint end; measured through a simulation of the shipped chain the naive stitch reports the core 2.5x too wide and the two slopes as −1.910 / −6.783 (straddling the band in opposite directions for a single power law), i.e. three of four PSF criteria red on a HEALTHY renderer. Historical `--bracket` M4/M5 numbers are not comparable to current ones. Verdict arithmetic: `lib/celestial-g2-gate.mjs`, pinned by `celestial-g2-gate.spec.mjs` (**41 tests, 14 mutants**); `celestial-g1-gate.spec.mjs` is now **62/62**. Evidence: `output/celestial-g2.json` + `output/celestial-g2-*.png`. Watchdog 1200 s in `--g2` mode. **Edge acceptance for BOTH the re-scoped G1 and the new G2 is OWED — neither has run.** **★ 2026-08-07 (CO-24) — `--g3` ADDED**: the G3 star-map ASSET gate, five sub-lanes per backend (`asset`, `split`, `catalogue`, `adversarial`, `motion`), 18 bound predicates, verdict arithmetic in `lib/celestial-g3-gate.mjs` pinned by `celestial-g3-gate.spec.mjs`; needs `sharp` to decode the served cube faces off-browser; watchdog 1800 s; evidence `output/celestial-g3.json`. **★ 2026-08-07 (CO-27) — `--g4` ADDED, and with it all four C12 gate lanes now exist.** G4 is the Sun+Moon gate: six sub-lanes per backend (`policy`, `disc`, `halo`, `earthshine`, `terminator`, `phase`), **41 bound predicates per backend** at this commit (43 counting the two gated arms), plus 8 cross-backend fold predicates, must pass IDENTICALLY on both — every term is CPU-resolved and published on `frameState` before the backend branch (`SunDiscAppearance`, `SunHaloAppearance`, `MoonPhaseAppearance`), so a one-backend pass is a FAIL. **Sun:** disc angular diameter (§5's 0.5334° ± 5%, plus ± 3% against the same-frame ephemeris) and the **B906 pin `disc_trueSizeRatio_is_sqrt2`** (1.41421 ± 5%, measured at PIXELS from the two `enableTrueSolarDiscSize` positions); limb darkening by a DIFFERENTIAL (`enableSolarLimbDarkening = false` passes `(1,0,0)`, so `flat − limb` isolates `1 − I(x)` and the screen halo CANCELS EXACTLY) — presence, shape vs the shipped law, and vanishing at centre and outside the disc; the C12-18 halo measured between **16 and 30 R_sun**, past the billboard's own corner at `sqrt(2)·11 = 15.56 R_sun`, so the BAKE leg is the positive control that the band is empty without the post-process chain; the one-halo-source invariant read LIVE off `frameState.sunHalo` as an exhaustive truth table (both the DOUBLE-halo and NO-halo failures are named criteria); `halo_deltaPeak_at_11_Rsun` carrying B906's own sweep against the shipped `SolarDiscModel`; the eclipse alpha chain asserted **exactly 1** on the sunlit side; and the C12-28 SDR leg made non-vacuous by a LIVE positive control that forces `Scene._hdrDisplayIsHdr = true`, re-runs the shipped resolver, requires the flag to FLIP, then restores and requires it to flip back. **Moon — this lane IS `C12-21`'s and `C12-22`'s owed Edge acceptance:** three epochs solved in-page with the moon-appearance demo's own `findTimeForPhase` over its own window, at fovX 22° so the C12-22 band is 2.7 px rather than 1.0 (**the moon is NOT resized**); earthshine's unlit-limb delta must be present at the crescent, carry the shipped ashen tint (scale-free B/R and G/R ratios), **scale with the LIVE resolved `moonEarthshinePhaseScale`**, and go inert at full; the terminator softening must produce a thin non-negative band with **exactly zero darkened pixels** (the model's own pointwise property, which is what rejects the `smoothstep` GATE mutant). **⚠ ONE CRITERION IS A PENDING ARM:** §5's `I(0.95R)/I(0) ∈ [0.3,0.5]` needs `C12-19` (removes the `clamp(...,0,1)` from both bakes). It self-activates from two independent live discriminators — the served bake's clamp text and the measured peak disc radiance against a bound the clamped build cannot exceed — reports `STRUCTURAL-pending-content:C12-19` BY NAME in its own printed block, measures and prints the ratio every run, and treats a DISAGREEMENT between the discriminators as STRUCTURAL. **⚠ §5's moon full:quarter bar is REACHABILITY-GATED** on phase angle ≤ 5.0° (derived from the shipped surge's own `h`), because the `C12-20` row requires the LS + surge PAIR to be gated together; outside it the arm is STRUCTURAL with the number printed, and the always-certifying fallback is the phase ORDERING. Verdict arithmetic AND the measurement composition live in `lib/celestial-g4-gate.mjs` (deliberately, so `celestial-g4-gate.spec.mjs` runs the real code over synthetic frames whose answer is known in closed form — **64 tests, 11 mutants**; two instrument defects were caught there before any browser ran). Watchdog 2400 s; evidence `output/celestial-g4.json` + `output/celestial-g4-*.png`. **Edge acceptance OWED — first G4 run ever; pre-registered exit 3 (STRUCTURAL), see the CO-27 overlay in `QUEUE_2026-07-19_CAMPAIGN12.md`.** |

### Post-process / effects

| Probe | What it covers |
| --- | --- |
| `probe-bloom-parity.mjs` | **Bloom uniform parity gate (Batch 240, NEW-BLOOM-UNIFORM-PARITY), webgl-vs-webgpu.** Default-uniform bloomed-pixel fraction ratio band [0.2x, 2x], glowOnly + brightness uniform response, 0 errors. Scene strips all backend-divergent env elements (sky/sun/skybox/imagery/water) — the ground-view divergences it documented are now fixed under NEW-GROUND-VIEW-ENV-DIVERGENCES (Batch 247). |
| `probe-taa-resolve.mjs` | **Regression gate for the Batch 244 TAA resolve activation** (NEW-TAA-EFFECT-NEVER-ADDED): TAA OFF→ON→OFF. OFF → no `_taaEffect`, msaa=4, baseline renders; ON → effect lazy-added + enabled, the resolve pass ENCODES (debug-pragma `resolveCount` strictly increases), velocity attaches, msaa=1, 60 moving frames 0 errors, settled scene temporally STABLE (consecutive-frame diff < 1%) and NOT smeared (camera rotation below the teleport threshold → image follows within one frame, billboard pixel count doesn't ghost-double); OFF → bypass (instance kept, `enabled=false`, `resolveCount` frozen), velocity detaches, msaa restored. Run after any change near the TAA effect, the post-process configure pass, or the TAA↔MSAA coupling. |
| `diag-taa-black.mjs` | One-off device-`pushErrorScope` diagnostic that found the Batch 244 latent failures (depth+filtering sampler pipeline rejection; G-buffer MSAA mismatch killing the scene pass). Template for "pass runs but output black with 0 console errors" investigations — uncaptured validation errors don't always reach the console; an explicit error scope catches them. |
| `probe-bloom-no-globe.mjs` / `-no-msaa.mjs` / `-no-pp.mjs` / `-no-sky.mjs` / `-side-by-side.mjs` / `-tile-state.mjs` | Bloom bisection variants |
| `probe-msaa-comparison.mjs` | MSAA on vs off |
| `archive/probe-tonemap.mjs` (BROKEN_STALE — archived 2026-08-16, M1) / `probe-gamma-chain.mjs` | Tonemap + gamma chain |
| `probe-postprocess-f16.mjs` | **f16 post-process opt-in gate (PARITY-F16-POSTPROCESS).** Two WebGPU passes (default vs `scene.context.useShaderF16 = true` set BEFORE enabling the lazy effects), per-effect captures for bloom/AO/DoF/god-rays/SSR. Hooks `GPUDevice.createShaderModule` to detect `enable f16` modules: OFF pass must compile ZERO (byte-identical off-gate), ON pass must compile all lazily-wired f16 variants when the device grants `shader-f16`, or ZERO (graceful f32 double-gate) when it doesn't. Per-effect off-vs-on closeness (meanAbs < 2.5, >12-diff fraction < 2%), 0 console/GPU errors, no "f16 variant rejected" fallback. |
| `validate-f16-wgsl.mjs` | Static naga (wgsl-in + validator) check of every `PostProcess/*_f16.wgsl` — the compile-verification companion to `probe-postprocess-f16.mjs` for GPUs without `shader-f16` (e.g. NVIDIA Pascal), where the browser can never compile the f16 variants at runtime. |
| `probe-hdr-pp-math.mjs` | **HDR-aware ColorGrading + FXAA gate (PARITY-HDR-PP-MATH).** SDR pass + HDR pass (`scene.highDynamicRange = true` + `scene.useHDRCanvasOutput = true`) on a deterministic scene. Asserts: HDR canvas actually engages (rgba16float + `pp._hdrOutputMode`), ColorGrading + FXAA render passes RUN under HDR (labels recorded via a `beginRenderPass` hook) while Tonemap is bypassed, output plausible (non-black/non-blown/alpha intact), 0 console/GPU errors, all four WGSL variants compile clean on-device, and the SDR captures are **byte-identical** to a pre-change baseline (`--baseline` mode saves it). Run after any change to ColorGrading/FXAA WGSL, `setHDROutputMode`, or the HDR canvas configure path. |
| `probe-globe-hdr-gamma.mjs` | **Globe czm_gammaCorrect under HDR canvas output (GLOBE-HDR-GAMMA).** SDR pass + HDR pass (`highDynamicRange` + `useHDRCanvasOutput`) over a two-tone (sRGB 100/180) full-globe SingleTileImageryProvider drape. Asserts: HDR canvas engages, the HDR region means equal the **single** sRGB→linear decode of the SDR tone (`255·(sdr/255)^2.2` ± 10, and explicitly NOT the missing-correction `== sdr` or the double-decode `^4.84` values), 0 console/GPU errors, and the SDR capture is **byte-identical** to a pre-change `--baseline`. Includes a cold-browser guard (waits for the globe to actually rasterize — first page of a fresh browser can stay black long after `tilesLoaded`) and uses a full-globe imagery rectangle (the WebGPU globe renders nothing for zero-layer tiles in a stripped scene). Run after touching `czm_gammaCorrect`/the imagery gamma branch in `GlobeTerrain.wgsl`, the camera-UB `hdrControl` packing, or the HDR canvas gate. |
| `probe-colorgrading-wired.mjs` | **ColorGrading runtime-caller gate (WIRE-COLORGRADING-CALLER, Batch 482).** Exercises the scene-level opt-in (`scene.colorGradingEnabled = true` + `scene.colorGradingConfig`) on a settled deterministic scene: default frame has NO ColorGrading pass (stage never added — off by default), enabling a strong warm grade adds the pass + visibly grades, assigning a NEW config object re-grades at runtime (`updateColorGradingUniforms`), disabling returns BYTE-IDENTICAL to the default capture, 0 console/GPU errors, and the default capture byte-matches a pre-change `--baseline`. Captures use a settle-and-grab loop (tilesLoaded + two grabs 10 frames apart byte-equal) — captures taken mid tile-refinement are not comparable. Run after any change to the PP configure pass or the ColorGrading stage. |
| `probe-pp-library-builtins.mjs` | **PostProcessStageLibrary built-ins interception (WIRE-PP-LIBRARY-BUILTINS).** All 7 named library stages (BlackAndWhite, Brightness, NightVision, Silhouette, EdgeDetection, DepthView + a dedicated space-view LensFlare section) added via `PostProcessStageLibrary.create*Stage()` on BOTH backends over a deterministic scene (boxes for depth edges + bright point): each stage visibly transforms the frame on both backends, cross-backend mean-abs-delta within per-stage tolerance, `LibraryPP-*` render-pass labels appear only while a stage is enabled, remove-all returns the WebGPU frame BYTE-IDENTICAL to the default capture, 0 console/GPU errors. LensFlare runs at ~2 earth-radii altitude with the sun ~15° off-axis — closer/overhead cameras degenerate the GLSL isInEarth projection and mask all ghosts on both backends. **HDR phase (NEW-PP-LIBRARY-TONEMAP-ORDER):** a separate startup-HDR page pair (`scene.highDynamicRange=true` BEFORE first render — a mid-session toggle trips a pre-existing scene-pipeline format-mismatch bug) over a white-point-only scene (white/black are gamma fixed points, isolating the PP chain from the plain-HDR scene-side gamma gaps) asserts the WebGPU tonemap pass is recorded BEFORE the LibraryPP pass, disc-interior medians match WebGL (base ~239 = Khronos PBR-Neutral of 1.0 sRGB-encoded; BlackAndWhite ~204 = posterize band 0.8), and whole-frame mean ≤ 2. Run after touching `WebGPULibraryPostProcessStage.ts`, the configure pass's user-stage scan/sync, the stage-removal compaction, any of the 7 library WGSL twins, `Tonemapping.wgsl`/`Tonemapping_f16.wgsl`, or the execute() tail ordering in `WebGPUPostProcessPipeline.ts`. |
| `probe-pp-library-demo.mjs` | **`webgpu-post-process-library` Sandcastle demo acceptance (NEW-WEBGPU-PP-LIBRARY-DEMO).** New-format gallery `main.js` can't boot standalone (bare `import "cesium"`), so — per the `probe-dp46f-metadata-demo` precedent — replicates the demo's exact scenario (CesiumMan asset, the 7 stage factories + uniforms, model/space views) in the CesiumViewer WebGPU page and drives the demo's add-stage/remove-stage cycle: asset serves, each effect visibly transforms its baseline (screenshot per effect; thin-outline silhouette/edge entries use a lower byte threshold), the "None" state (collection emptied after an add/remove cycle) is BYTE-IDENTICAL to the true no-PP frame, 0 console/GPU errors. Uses a fixed `camera.lookAt` (trackedEntity easing aliases the settle loop) and the strip-ion-imagery-until-settled loop. Run after touching the demo, the user-stage rebuild detection (`_userStagesRefs`), or stage add/remove handling. |
| `probe-post-process.mjs` | Post-process pipeline state |
| `probe-volcloud-toggle.mjs` | Volumetric clouds toggle |

### Pipeline / shader / device

| Probe | What it covers |
| --- | --- |
| `probe-adapter-limits.mjs` / `-adapter-limits-quick.mjs` | GPUAdapter limits |
| `probe-attach-mismatch.mjs` | FB attachment mismatch |
| `probe-bundle-content.mjs` | Build bundle bytes inspection |
| `probe-cmd-pushes.mjs` / `-pass-counts.mjs` / `archive/probe-trace-counts.mjs` (BROKEN_STALE — archived 2026-08-16, M1) | Command / pass counts per frame |
| `probe-console-errors.mjs` | Console-error stream |
| `probe-debug-snapshot.mjs` | `scene.getDebugSnapshot()` dump |
| `probe-draw-calls.mjs` / `-draw-pipeline-labels.mjs` / `-direct-draw-fb.mjs` | Draw-call instrumentation |
| `probe-fb-after-draws.mjs` / `-fb-config.mjs` / `-sceneframebuffer.mjs` | Framebuffer state |
| `probe-imagery-tex.mjs` / `probe-tex-format.mjs` | GPU texture format (historical predecessor: `archive/probe-gpu-tex.mjs`, archived 2026-08-16, M1) |
| `probe-gpu-timestamp-profiler.mjs` | **The C11-140 certification lane for GPU-timestamp unique-sample accounting** (2026-08-07; hardened 2026-08-09). Real-adapter timestamp capability, opt-in lifecycle, post-submit readback, named core-pass samples, and browser error gate — now over 5 reps of a bounded moving-altitude arc (idle capture is not a valid certification), draining the readback tail via `drainPendingReadbacks()` and asserting that the sample ledger closes and `coverageRatio + unprofiledRatio ≈ 1`. The lane boots with `offline=true`, rejects every external request and console/page error, and exits `3` with recorded structural reasons when the resolved adapter lacks `timestamp-query`; an unsupported adapter can no longer write `certified:false` and exit successfully. Writes `gpu-timestamp-accounting-certification.json`; **cite that artifact rather than re-deriving whether the timer is trustworthy.** **[Probe hardening + banked certification artifact landed Batch 1074 (`d36a835b82`), 2026-08-20; the fresh-bundle route rerun ran tonight in the machine lane — exit 0, clean gates.]** |
| `gpu-timestamp-unique-sample-accounting.spec.mjs` (`node --test`, no browser) | Browser-free half of the C11-140 guard. Proves the union fold (overlapping passes cannot inflate coverage past the span, and `overlapMs` names the double-count) and drives the real profiler against a fake `GPUDevice` to prove the ledger closes across sampled/empty/skipped/lost/pending frames and that the drain is bounded. Includes a negative control on the ledger, a source anchor that the clamped sum/span ratio does not return, and contracts pinning the offline/error/structural-exit behavior of the browser probe. Focused result after the 2026-08-09 hardening: 13/13; the real Edge artifact remains owed. **[Discharged: the artifact landed with Batch 1074 (`d36a835b82`), 2026-08-20.]** |
| `settle-attribution.spec.mjs` (`node --test`, no browser) | The C11-146 guard. Pins the settle-window attribution rule (a settle window with zero main-thread long tasks is GPU-submit bound, so a main-thread closure/churn fix may NOT book stable-time credit) and the first-complete-frame metric (every SELECTED tile drawing its own loaded mesh with imagery ready, held N frames). Also anchors that `run-performance-campaign.mjs` keeps `frameNumber > 0` unchanged — the new metric is additive so the C9-30 / Gate-A baselines stay comparable. |
| `spec-offline-isolation.spec.mjs` (`node --test`, no browser) | The C11-134 guard. Pins the external-URL classifier (fail-closed on anything it cannot resolve), the online-lane quarantine (`describeRequiresNetwork` → truthful `"requires network"` skip offline, unchanged run online), the fetch/XHR guard, and the roster of specs that still reach a live service. |
| `probe-webgpu-allocation-tax.mjs` | Independent Node/Edge API-boundary allocation/upload/pass/submit probe. Fails if explicit WebGPU opens WebGL/WebGL2; `--strict-native` additionally rejects `GL Compatibility` buffer labels for migrated fixtures. It reports `GLStub_*` textures as compatibility-shaped without calling them duplicates: they may be the sole physical realization. Buffer bytes are exact, texture bytes are descriptor estimates, and decoded/backend ownership evidence is still required. |
| `run-performance-campaign.mjs` + `performance-workloads.json` | Versioned deterministic Node/Edge workload runner. Captures full-Scene CPU p50/p95/p99/MAD, capability-available GPU timestamps/remainder, long tasks/heap diagnostics, startup, renderer snapshots, and a per-run `gpuProvenance` record. The provenance record places `context.getRendererString()` beside WebGPU `adapter.info`; a run cannot PASS without the applicable physical-GPU identity, preventing a silent WebGL/WebGPU adapter mismatch from being mistaken for an engine delta. CPU/GPU metrics are primary; rAF wall time is diagnostic and may be refresh-limited. |
| `run-performance-campaign.mjs --api-instrumentation --no-gpu-timestamps` | WebGL shader chronology and globe-request attribution. Use `firstDrawProgram` to distinguish actual drawing from `useProgram`, and correlate it with `globeShaderRequests` to audit camera height, `configuredEnabled` versus per-frame fog renderability, imagery-texture cohort, exact FOG/log-depth/HDR/shadow selection, companion eligibility, and preparation/pending counts. |
| `probe-perf-regression-gate.mjs` | **C11-170 re-upload/churn regression gate — AUTHORED, NOT YET RUN IN ACQUIRE MODE.** Spawns the four C11-169 diagnostics sequentially (one Edge at a time, `cwd` = repo root, `PROBE_BASE` pinned; `probe-cpu-sampling-profile` at `--frames 120` because the banked visibility floor came from a 120-frame profile), proves each report fresh by sha256 change **and** in-file timestamp ≥ gate start, then adjudicates seven signals whose bars are derived from those probes' own banked post-fix artifacts: A resource-write self-time share < 0.193 (the profile's published visibility floor, both backends), B/C settled-scene non-drain and render-request churn < the Rule-of-Three bound `3/n` with `n` read from the report, D zero live WebGL contexts in the `webgpu-solo` getContext census (fenced by a live-WebGPU check and by agreement with the producer's own `Q1` verdict), E same-run CPU wall-clock ratio ≤ 2.8737075, F canonical status passthrough of the C11-169 frame gate, G positive-only scan for the engine's `RE-UPLOAD STORM` sentinel — a trusted hit is FAIL, a present-but-malformed console array or a stale source report is STRUCTURAL, and a clean scan is NOT-PROVEN, never PASS. A missing report, an absent scalar or an unproved freshness is **STRUCTURAL, never PASS**; `--adjudicate-only` re-adjudicates on-disk reports with no browser and is **capped at STRUCTURAL** so a stale green is impossible. Exit codes are the frozen fleet table. **It certifies nothing** — its inputs are the noncausal/noncertifying C11-169 diagnostics and every artifact says so, PASS included. Signal G's collection path is a declared blind spot (`NEW-C11-170-SENTINEL-UNOBSERVABLE-TO-GATE`): the sentinel text matches neither `WEBGPU_FAULT_RE` nor survives the backend-isolation six-entry console cap. Browser-free half: `c11-170-perf-regression-gate.spec.mjs` (`node --test`), which executes the exported adjudicator over the banked artifacts plus storm / field-absence / bar-widen / inertness mutants. |
| `probe-magenta-clear.mjs` / `-webgpu-grey.mjs` | Sentinel-color clear checks |
| `probe-shim-debug.mjs` / `-shim-trace.mjs` | GLSL→WGSL stub-translator tracing |
| `probe-wgsl-doctype.mjs` | WGSL parse sanity |
| `probe-vec4-error.mjs` | vec4 layout error reproduction |
| `pipeline-key-aliasing.spec.mjs` (`node --test`, no browser) | **The guard for `NEW-WEBGPU-PIPELINE-KEY-DEFINE-AXIS-GENERAL` (63/63 after the PipelineVariant survivor; 59/59 at Batch 825).** Its STRUCTURAL group executes the REAL render + compute caches over every bit of the REAL `ShaderDefine` registry using identically-named, MARKERLESS descriptors and requires distinct keys — enumeration of expected markers was deliberately replaced by execution, because an enumeration test passes for a marker nobody reads. It also pins normalized blend/write state, explicit-target precedence, null MRT slots, stencil-only `depthTest:false`, and that modifier-only depth variants cannot synthesize a depth attachment. Its MUTATION-FOLD group rewrites a copy of the engine source to REMOVE the module-identity fold and requires the aliasing to come back. Producers that intentionally bypass the central cache declare themselves under `NO_CENTRAL_CACHE`. Run it after touching `WebGPURenderPipelineCache.generateCacheKey`, `WebGPUComputePipelineCache`, or `WebGPUShaderModuleCache`'s key. |
| `probe-pipeline-key-aliasing.mjs` | **Real-hardware half of the same guard (Edge, PASS both modes at Batch 828).** `detect` mode instruments live pipeline creation: 3,729 calls / 13 covered producers, with the probe's own detector AND the engine's `stats.wrongModuleHits` both 0 and 0 collisions. `--expect-collisions` is the negative control and MUST fire — a guard that cannot produce a failure when the defect is reintroduced is not a guard, and the Batch-825 fold broke the control's old mechanism, so the control run is the load-bearing one. A live key looks like `pl:11 \| pr:triangle-list/back/ccw//0 \| dz:1/less-equal/0/0/0//// \| mx:/0 \| sh:13.vertexMainWebMercNormals/13.fragmentMain`. Requires a rebuilt tree — the built `Source/` is what the browser loads. |

### Async / streaming

| Probe | What it covers |
| --- | --- |
| `probe-async-resource-monitor.mjs` | Async resource lifecycle |
| `probe-empty-scenes.mjs` | Scenes with nothing to render (background / clear) |
| `archive/probe-globe-timing.mjs` (BROKEN_STALE — archived 2026-08-16, M1) | Tile selection timing |
| `probe-replay-cesium-cmd.mjs` | Replay a captured Cesium command stream |
| `probe-c11-205-lifecycle-v2.mjs` | **C11-205 lifecycle schema-v2 browser proof (attribution-only — NOT a performance timing run).** Loads the real 3D Tiles 1.1 multiple-contents fixture on both backends (`PROBE_RENDERERS=webgl,webgpu`), installs the side observer BEFORE payload requests begin, and requires exact per-slot request evidence plus model, content, and tile readiness evidence. Env: `PROBE_BASE` / `PROBE_RENDERERS` / `PROBE_HEADED`. |
| `tileset-request-ledger.spec.mjs` (`node --test`, no browser) | C11-205 request-ledger contracts over `lib/representative-tileset-request-ledger.mjs`: stable cross-leg request identity (ignores local IDs, global interleaving, frame origin, byte outcomes), cancel/scheduling-deferral/reissue per-tile chronology, late cancellation preserving accepted content as completed, mutation attribution (URL/lifecycle/reissue), fail-closed on malformed or incomplete evidence, and schema-v2 multiple-content slot normalization incl. numeric slot ordering beyond ten entries. |
| `tileset-lifecycle-v2.spec.mjs` (`node --test`, no browser) | C11-205 schema-v2 observer contracts over `lib/representative-performance-content.mjs`'s lifecycle tracker, driven by fake tileset/request/content doubles: real inner-request observation through model/content/tile readiness with prototype restore, cancelled-generation separation from reissues, whole-group discard after a slot already completed, scheduler cancellation without `cancelRequests`, per-slot deferral / factory failure / destroy-before-ready outcomes, schema-1 reissue-after-cancellation backfill, and destroy freezing diagnostics before pending async observers settle. |

### Specific subsystems

| Probe | What it covers |
| --- | --- |
| `probe-edge-emitter.mjs` | Edge-visibility / line-emitter |
| `probe-bufferpolygon-vector-tile.mjs` | Modern glTF-vector (`CESIUM_mesh_vector`) BufferPolygon fill — WebGL vs WebGPU `sample-us-states` load + canvas diff + feature/geometry/error metrics |
| `probe-geojson-primitive.mjs` | **`GeoJsonPrimitive.fromGeoJson` end-to-end gate (GeoJsonPrimitive ships in FEATURE_INVENTORY §A; this probe gates the buffer-primitive parity end-to-end through the loader).** Loads a mixed `FeatureCollection` (Point + LineString + Polygon **incl. a hole + a MultiPolygon**) on BOTH backends and canvas-diffs — exercises the `parseGeoJson` polygonVertexCount/holeCount/triangleCount → Buffer*Collection capacity allocation math (wrong capacity trips `ERR_CAPACITY` or silently truncates). Also validates the buffer-primitive `color.alpha` / `blendOption` / `boundingVolume` parity fixes end-to-end through the loader. Demo: Sandcastle "WebGPU GeoJsonPrimitive". |
| `probe-bufferpolygon-2dcv.mjs` | **Buffer* collections in SCENE2D / Columbus View (NEW-BUFFERPOLYGON-2DCV-REPROJECT).** BufferPolygon/Polyline/Point fill at a fixed top-down view in 3D / 2D / CV, WebGL vs WebGPU coverage — surfaces the missing 2D/CV reprojected attribute buffer (buffer renderers project RTE ECEF via `modelViewRelativeToEye * projection` with NO CPU-reprojected ENU buffer, unlike the Vector3DTile classifiers), so 2D/CV markers wander or vanish. Distinct from `NEW-CLASSIFIER-2D-CV-MORPH` (that covers the `.vctr` classifiers, not the BufferPolygon family). |
| `probe-bufferpoint-positiondatatype.mjs` | **Non-DOUBLE / `positionNormalized` BufferPoint encode gate (tracked in WEBGPU_PARITY_AUDIT_2026-06, positionNormalized P2 row).** Drives a collection with an integer/normalized `positionDatatype` (snorm/unorm) vs the default DOUBLE Float32 high/low RTE path. All three renderers currently assume DOUBLE positions (always float32x3 high/low), so a non-DOUBLE store is silently mis-encoded (integer bytes read as f64 cartesians). Run after touching the Buffer* vertex-layout/datatype variant or the non-RTE upload path. |
| `probe-edge-degenerate.mjs` | **Degenerate-triangle glTF edge gate (NEW-UPSTREAM-EDGE-DEGENERATE-13421; PR#13421 repro).** A glTF carrying a zero-area triangle adjacent to a real silhouette edge, WebGL vs WebGPU edge-pixel coverage — confirms no NaN (magnitude guard + bounds skip) AND that the WebGPU synthesized-face-normal path classifies the silhouette like WebGL's authored-`silhouetteNormals` path (a zero-area tri biases the silhouette dot-product differently when normals are re-derived from positions). Node-side; esbuild-bundles the `.ts` emitter itself (repaired 2026-07-02: previously exit-2 demanding a compiled `.js` sibling nothing emits, and scanned the vertex buffer with the stale pre-Batch-330 15-float stride). Run after touching `WebGPUEdgeVisibilityEmitter.ts`. |
| `probe-edge-authored-silhouette.mjs` | **Authored `silhouetteNormals` accessor gate (EDGE-AUTHORED-SILHOUETTE-NORMALS, 2026-07-02).** [A] Node-side numeric: esbuild-bundles the emitter, feeds a synthetic primitive whose authored signed-byte pairs deliberately differ from the adjacency-derived normals, asserts WebGL-identical decode (`2*((v+128)/255)-1`, normalize, (0,0,1) fallback), sequential dedupe-order pair indexing, zero normals for out-of-range pairs, and the derived fallback when the accessor is absent (off-gate). [B] Visual: `EdgeVisibility.glb` (authors 40 silhouette pairs) in EDGES_ONLY on both backends at 2 headings; edge-lit masks must have <6% orphan pixels (dilation r=3). Run after touching `extractEdgeGeometry` or the silhouette WGSL branch. |
| `probe-gsplat-parity.mjs` | **C15-G1 Gaussian-splat harness — the DUAL-MODE gate every later GSPLAT row runs through (2026-08-07).** Loads an in-tree splat tileset (`--asset=sh_unit_cube` default, `tower`, or `both` — served from `Specs/Data/Cesium3DTiles/GaussianSplats/` by the repo-root static mount, no Ion, no network) on BOTH backends at a camera derived from `tileset.boundingSphere` (no hardcoded ECEF), globe hidden, pinned clock, same-task capture. Scored quantity is pixels the tileset ADDED versus the same settled scene with `tileset.show = false` — never "non-black pixels" — with structure floors (edge fraction + luminance σ) so a flood fill cannot satisfy the 2% added-pixel gate, and a two-sided negative control (hidden frame blank, hiding again returns to it, ON beats the control 10×, same metric same reference). **AS OF `C15-G3` (2026-08-07) RUN IT WITH `--expect-webgpu`.** The stage retired every named absence blocker, so `STAGE.required` is empty and DEFAULT mode structurally refuses to certify anything (`webgpu:stage-requires-expect-webgpu`, exit 3) — that is correct, not a regression. The probe stays dual-mode and still collects every blocker. In flip mode, absence is exit 1 and presence is scored against the reference leg's OWN structure battery applied to the WebGPU leg (added ≥ 2%, edge fraction, luminance σ, 10× negative-control margin, clean console) plus splat-count equality, printing `WEBGPU-SPLATS-PRESENT (C15-G3)`. **The cross-backend parity diff is MEASURED and PRINTED but NOT GATED at `C15-G3`** — the WGSL has no spherical-harmonics term until `C15-G5` and both gate tilesets are SH degree 3, so the diff scores the missing view-dependent colour rather than the record decode; the `C15-G8` thresholds (tower 3%, cube 1%) are unchanged and `STAGE.parity.scored` flips them back on at `C15-G5`. Historical DEFAULT-mode behaviour (`C15-G1..G2`): certified the documented absence with the greppable `WEBGPU-SPLATS-ABSENT (expected until C15-G3)` marker at exit 0, but only when attributable to a named observed blocker. The parity leg refuses to emit a number when the WebGPU leg drew nothing — two blank canvases diff to 0.000%. Nine structural preconditions incl. `capture-liveness` (paints the scene a known colour and requires the readback to see it, so the Batch-227 dead-readback trap cannot be filed as a WebGL defect) and `pass-enum-exported` (`indices[undefined] \| 0` is 0, which would MANUFACTURE the absence). Verdict arithmetic lives browser-free in `lib/gsplat-parity-model.mjs`, **`C15-G4b` (2026-08-07) fixed the determinism control itself.** The pair used to bracket `await settleMs(2000)` — thousands of event-loop yields, every one a landing site for an async resolution — and `tower` exited 3 on it at Batch 890 (WebGL 0.052% vs a 0.050% bar; `sh_unit_cube` 0.000%). The two captures are now taken **back-to-back in ONE task**, so nothing can interleave by the JS execution model rather than by a timing hope, and a new STRUCTURAL precondition **`sort-quiesced`** (checked immediately before `capture-determinism`, because it is a precondition of it) renders until the sort provenance holds steady for a full settle window with nothing in flight. The quiescence signature is **backend-neutral** — `_indexesSortSequence`/`_indexesDataGeneration` (the `C15-G4` stamp) plus `_sortRequestId`, because the leg that failed is the one with no `_webgpuCache`. New `[QUIESCE]` summary line. **The 0.050% bar was NOT widened** and a mutant forbids it. Note the proposed steady-sort mechanism is REFUTED at this probe's frozen camera (`shouldStartSteadySort` needs ≥ 1.0 m or ≥ 0.5° and the camera is set once) — see `C15-GSPLAT-TOWER-FRAME-VARIANCE` in DEFERRED_WORK for the conditional open question the next run decides. **`C15-G4` (2026-08-07) added the sort observables to the summary output** — the `sort:` line prints `comparatorSorts` (the row's exit gate: **0**, meaning the synchronous main-thread comparator never executed), `providedUploads` (its anti-vacuity partner: **> 0**, else 0/0 is "nothing sorted at all") and `superseded` (out-of-order resolutions the sequence guard refused at the buffer-upload boundary). All three are read straight off `primitive._webgpuCache`. Verdict arithmetic lives browser-free in `lib/gsplat-parity-model.mjs`, pinned by `gsplat-harness.spec.mjs` (`node --test`, **179 checks**): the model rules × real + a mutant battery, the `C15-G2` structure anchors, the `C15-G3` record-layout battery, the `C15-G6h` derived-bounds battery, and the `C15-G4` sort-swap battery — `uploadProvidedSortOrder` is EXTRACTED FROM SOURCE AND EXECUTED over ordered resolutions (out-of-order, equal-sequence, older/newer generation, unstamped, length-mismatch, unresolved, throwing write) with 8 mutants — the packed WGSL decode and the GLSL decode are both PARSED from source and required to name the same u32 word and the same f16 half for every covariance term, a known (scale, rotation) triple round-trips through the 8-u32 record, the flat-`count*8` slice premise is proven algebraically from the engine's own row mask/shift, Naga validates all four `(LOG_DEPTH × SPLAT_PACKED_WASM)` variants, and 7 WGSL mutants (swapped covariance halves, wrong colour word, BGRA order, legacy stride, shifted position words, asymmetric Sigma) must be rejected. **`CO-12` (2026-08-07) added THREE LANES `C15-G5` certified without and `C15-G8` cannot gate without** — all three run only under `--expect-webgpu`, all three fold into the exit code, and the watchdog default rose 600 s → 1200 s to pay for them. (1) **Three azimuths** — the tileset is orbited to headings **0 / 120 / 240°** (heading 0 stays FIRST and IS the historical single camera, so every recorded number is unchanged), each with its own hidden-tileset reference frame, its own `waitForSortQuiescence` (a 120° move is exactly what triggers a steady sort) and its own same-task determinism pair; a cross-backend diff and diff PNG per azimuth. Two anti-vacuity guards run BEFORE any mismatch is read: adjacent view directions must be the **DERIVED 97.18076°** apart (`acos(cos²p·cos d + sin²p)` at p = −30°, d = 120° — the spec re-derives it from the probe's own pitch, it is not a constant) and each orbit step must change ≥ **0.25 × the measured added fraction** on the reference leg. Recorded-not-gated until `C15-G8` arms `STAGE.controls.azimuth.scored`. (2) **SH-off vacuity control** (`[SH-OFF]` line) — drives `primitive._sphericalHarmonicsDegree = 0`, which is the ENGINE's own seam (`resolveSplatShSource` → `activeShEnabled` → `shFlipped` → the renderer recompiles the no-SH `//>>else` variant, i.e. the pre-`C15-G5` renderer), waits on `resourcesShEnabled === false && cache.pipeline` (the flag alone would capture mid cold-compile), captures at all three azimuths, then restores and **gates the restoration**. GATE: the cross-backend mismatch must clear the asset threshold at ≥ **2 of 3** azimuths, expected back at the recorded **2.574%**; a 0.000% SH-off run is a FAIL and proves the SH term is vacuous. Gated on `sh_unit_cube` only — tower's pre-G5 residual has never been measured, so a floor for it would be invented. (3) **Corrupted-covariance vacuity control** (`[COV-CTRL]` line) — corrupts words 4-6 of the packed record on a **COPY** of the payload by shifting the half-float EXPONENT +2 (an exact ×4, Inf/NaN clamped away, never written in place), publishes it as a new payload object (the engine's producer-identity dirty signal), waits on `cache.splatSourceToken`, and withdraws it with the withdrawal gated. Two arms: **single** (splat 0, gated on the cube only — the DERIVED per-splat footprint is 19.141%/27 = 0.709% on the cube versus 1.4e-7 on tower, i.e. below the instrument's resolution) and **bulk** (every 2nd splat, gated on both against the asset's parity threshold — this is the arm that proves the gate can fail). Both controls are GATES at every stage while the azimuth ceiling is not; see `STAGE.controls` for why a floor and a ceiling do not arm together. Harness **179 → 267 checks**, incl. 20 executable lane rules + 9 lane mutants, and the new `CO-12` batteries for `NEW-SPLAT-PENDING-WORK-DRAWCOMMAND-PROXY` (the `hasDrawableResult` predicate extracted and executed over a six-row truth table) and `NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT` (`Pass.js` parsed by execution; zero numeric pass literals allowed under `Source/Renderer/WebGPU/`, no allowlist). Evidence → `output/gsplat-parity/` (now also `*-az{120,240}-on.png`, `*-parity-diff-az*.png`, `*-shoff-az*.png`, `*-corrupt-{single,bulk}.png`). |
| `probe-splat-sort.mjs` / `probe-splat-globe-occlusion.mjs` | WebGPU splat back-to-front sort + globe occlusion, driven by a **synthetic** hand-rolled primitive (`show: true`, `_splatData` pre-filled). **`probe-splat-globe-occlusion` gained a per-pixel premise at `C15-G3c`:** it measures the globe on its OWN splats-hidden, chrome-hidden frame and splits the green verdict into `greenOverGlobe` (a real depth-compare leak - the product check, `< 50`) and `greenOverVoid` (nothing behind it - STRUCTURAL precondition P1, exit 3). Before that, `globePixels` was derived as `nonBlack - red - green`, so the red splat's own halo and the viewer chrome counted as globe and check 1 could not fail for "the globe did not render" - which is exactly the state it was in. They exercise the renderer, NOT the production data path — see `probe-gsplat-parity.mjs` for the production-asset gate. Their 16-float/64-byte `_splatData` is now the **legacy** record: `C15-G3` made production consume the 32-byte WASM record behind `ShaderDefineHi.SPLAT_PACKED_WASM`, and these probes keep the `//>>else` branch alive, so they are the standing regression gate for it (they must stay green). |
| `probe-czml-bytes.mjs` | CZML byte-level parsing |
| `probe-png-bytes.mjs` | PNG byte-level decoding |
| `probe-mars-diag.mjs` | Mars (alternate-ellipsoid) diagnostics |
| `probe-bathymetry-state.mjs` | Bathymetry / ocean state |
| `probe-particle-sample.mjs` | Particle system sampling |
| `probe-bisect.mjs` | Generic bisection harness |
| `probe-hello-sc.mjs` / `-clean.mjs` / `-wgl.mjs` | Minimal Sandcastle smoke |
| `track-entity-probe.mjs` | Entity tracking |

### Verify-* scripts (fixed regression checks)

| Script | What it checks |
| --- | --- |
| `verify-b3dm-render.mjs` | B3DM tileset renders |
| `verify-batches-106-109.mjs` | Specific batch regression |
| `verify-classification-fr.mjs` | Classification feature renderer |
| `verify-glb-renders.mjs` / `-glb-side-by-side.mjs` | glTF model rendering |
| `verify-gp-debug-volume.mjs` / `-gp-no-polyline.mjs` / `-ground-polyline-zoom.mjs` | Ground primitives |
| `verify-hdr-taa.mjs` / `-initial-hdr.mjs` | HDR + TAA |
| `verify-model-feature-pick.mjs` / `-pick-webgl-control.mjs` | Picking. **Updated Batch 207**: uses `scene.pickAsync` (the WebGPU-correct async readback) + forces `EllipsoidTerrainProvider` + projects the model center to screen + grid-scans for a hit. Confirms FORK-34 is fixed. ~~The remaining residual: WebGPU picks the Model where WebGL returns a `Cesium3DTileFeature`.~~ ✅ **C-R9-MODEL-FEATURE-PICK RESOLVED (Batch 209)** — WebGPU now returns a `_Cesium3DTileFeature` with readable batch-table properties at full WebGL parity (`WebGPUModelFeatureId.js` registers `owner.getFeature(fid)` with kind `"tile-feature"`); this residual note is stale. |
| `probe-pick-basic.mjs` | **Minimal pick discriminator (Batch 206/207).** A plain Box `Primitive` + `pickAsync` — the smallest reproduction that the whole WebGPU pick path works. Box → `id:"the-box"` matches WebGL. Use this first when a pick regresses; it isolates the pick infra from any model/feature complexity. |
| `probe-hdr-pick-format-closure.mjs` | **Fleet-wide HDR/SDR pick-format matrix (Campaign 9 item 73, NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE).** Eleven offline pick-producer families (generic Primitive, Billboard, Label, PointPrimitive, Polyline, BufferPoint/BufferPolyline/BufferPolygon with `allowPicking: true`, GroundPrimitive, glTF Model, Voxel object + cell pick) placed at distinct lon/lat grid cells (NO show-toggling — toggling leaves stale pick-attachment pixels that alias across families) + a bare-globe control cell. Phases: SDR/ms1 → SDR/ms4 → runtime HDR flip/ms4 → mid-HDR viewport resize → HDR/ms1 → SDR restore. Asserts exact owners per family per phase, pick-FBO format == `context.pickPipelineFormat`, HDR actually flips the scene format, and the shared WebGPU error gate is silent. Writes `output/hdr-pick-closure/campaign9-hdr-pick-format-closure-2026-07-16.json` + phase PNGs. Run after touching `pickPipelineFormat`, `buildPickPipelineDescriptor`, `WebGPUDerivedCommand` PICK derivation, or any renderer's pick pipeline format. Note: WebGPU Model picks carry the per-glTF-primitive idKey as `id` (owner identity is `picked.primitive`); WebGPU buffer picks return `{collection, index}` and ignore `options.pickObject` (WebGL-parity gap, tracked in the C9 queue). |
| `probe-billboard-pick.mjs` | **Billboard pick gate (Batch 248, NEW-DERIVEDCOMMAND-VARIANT-FACTORY).** One billboard, `pickAsync` hit at center + miss control at an empty corner + repeatability + central pipeline-cache name hygiene (a billboard `::pick` variant name exists, NO duplicate descriptor names) + 0 errors. Run after touching `WebGPUDerivedCommand`, the billboard pick path, or pipeline-cache naming. Note: the first-ever pick warms the lazily-created pick pipeline (the probe warms up before asserting — pre-existing Batch 73 behavior). |
| `probe-collection-pick.mjs` | **Instrumented collection-pick chain lane (CO-16, NEW-WEBGPU-POINT-PICK-RESIDUAL).** The lane to run when a collection pick returns null. Offline black scene with one PointPrimitive + one Billboard + one Polyline + a geometry-`Primitive` POSITIVE CONTROL at four distinct screen positions; around ONE `pickAsync` per target it publishes the whole chain: **L1** did it paint at the cursor in a normal frame (same-task canvas read), **L2** pick-id key/color + whether the registered target is WebGL's `{primitive, collection, id}` wrapper, **L3** the per-`Pass` bin census (`context._diagPickPassCensus`: `binned`, `dedicatedPickBinned`), **L4** dispatch vs. `executePickBatch`'s skip clauses (`dispatched` / `skippedNonNative` / `skippedNoPickVariant`), **L5** its OWN `copyTextureToBuffer` of the pick FBO at the cursor (does not trust the engine's cached readback), **L6** `bytesToRgba → getObjectByPickColor`, **L7** what `scene.pick`/`pickAsync` returned (plus the sync path's stale-by-N attempt index). Prints an ATTRIBUTION block naming the first broken link, and the control separates "collections dead" from "pick infrastructure dead". Exit 0/1/2/3 — **exit 3 when `_diagPickPassCensus` is absent**, i.e. the page served a release build and L3/L4 are unobservable. Requires `Build/CesiumUnminified` (the census is debug-pragma'd). |
| `probe-pickposition-webgpu.mjs` | **pickPosition parity gate (Batch 252, NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION).** Runs BOTH backends at the same nadir view: WebGL reference pick; WebGPU cold-cache contract (frame 0 undefined → Cartesian3 by frame ≤3, never a Promise); cross-backend cartographic match (dLon/dLat ≤0.05°, dH ≤100 m); wheel-zoom-to-cursor smoke (camera descends on target, no NaN/garbage jump — guards the `handleZoom` degenerate-axis fix); 0 errors. Run after touching `PickDepth`, `Picking.pickPositionWorldCoordinates`, `SceneTransforms.drawingBufferToWorldCoordinates`, the log-depth encode, or the SSCC zoom path. **Warmup is `scene.globe.tilesLoaded`-gated + 60 settle frames (Batch 259, FQ-7)** — the fixed-90-frame warmup raced headless tile-depth population (depth read 1.0 everywhere → cold-cache sky-reject → all-undefined → flaky self-fail ~2/3 runs). The readiness gate reads `tilesLoaded` only (does NOT arm the pick readback, preserving the frame-0-undefined cold-cache contract). Reported `warmupFrames`/`tilesLoadedAt`/`tilesLoaded` diagnose any future flake. |
| `probe-pickposition-model-webgpu.mjs` | **pickPosition-over-opaque-Model gate (Batch 257, DP-H45).** Places a large opaque `CesiumMilkTruck` glTF model on the ellipsoid, nadir view from 8 km, warms 200 frames, then asserts WebGPU `pickPosition` at the model center returns the MODEL TOP (h matches WebGL within 30 m), NOT the globe behind/below it. Pre-fix the WebGPU leg returned the globe ~174 km off (dH ≈173887 m). Guards the post-OPAQUE depth re-pack in `WebGPUSceneRendererFrustumLoop.ts` — run after touching that frustum loop's depth-copy/update blocks, `WebGPUGlobeDepth.executeUpdateDepth/executeCopyDepth`, or the per-frustum pick-depth copy. |
| `probe-compute-instance-pickposition.mjs` | **`pickPosition` over a compute-instance gate (NEW-COMPUTE-INSTANCE-PICKPOSITION).** `scene.pickPosition` over a GPU-resident compute-instance returns THAT INSTANCE's world position on BOTH backends. Run after touching `getInstanceWorldPosition`, the `_pickableComputeInstanceFrame` gate in `ComputeInstanceCollection.js`, or the pickPosition compute-instance reconstruction. |
| `probe-sampleheight-webgpu.mjs` | **`sampleHeight`/`clampToHeight` gate (Batch 284, NEW-PICK-RAY-ASYNC; supersedes the FQ-5 Batch-254 honesty-warning assertion).** Asserts both now WORK on WebGPU via main-scene-depth reuse (the Batch-252 pickPosition reconstruction), not just emit a warning. Run after touching the async pick-ray path or the scene-depth reuse plumbing. |
| `probe-pick-ray-async.mjs` | **`sampleHeight`/`clampToHeight`/`pickFromRay` async gate (Batch 284, NEW-PICK-RAY-ASYNC).** WebGPU returns a globe-surface height/position matching WebGL via the main-scene-depth reuse path. The async sibling of `probe-sampleheight-webgpu.mjs`; run after touching the pick-ray reconstruction. |
| `probe-pick-metadata.mjs` | **Metadata/voxel synchronous-readback gate (Batch 285, NEW-PICK-METADATA-READBACK).** The synchronous center-pixel readback used by `scene.pickVoxel` (→ `Picking.pickVoxelCoordinate`) and `scene.pickMetadata` (→ `Picking.pickMetadata`) reads the JUST-RENDERED frame on WebGPU. Run after touching the metadata-pick readback path. |
| `probe-voxel-cell-pick.mjs` | **Per-cell voxel pick parity gate (C-R9-VOXEL-CELL-PICK reland + NEW-VOXEL-PICK-OCTREE-COMPOSE Parts B/C).** Part A: both backends render the 2×4×3 Y_UP staircase asset (probe-voxel-parity Part B's provider) and `Picking.pickVoxelCoordinate` is queried at 4 filled-cell pixels + 2 empty-column pixels + 1 off-box pixel: the 4 readback bytes must match WebGL byte-for-byte (decode to the same `{tileIndex, sampleIndex}` → cell), empty/off-box must be cleared `[0,0,0,0]` on both, and object pick (`pickAsync`) must still return the `VoxelPrimitive`. Part B (refined L1 octree pick): a two-level provider at the probe-voxel-octree close camera — SAMPLE bytes byte-equal + both backends' decode chains identify the SAME level-1 spatial octant (WebGL via `_traversal.findKeyframeNode(tileIndex).spatialNode`, the exact `Scene.pickVoxel` decode; WebGPU via the deterministic atlas slot→octant mapping `slot = 1 + (x + 2y + 4z)`). The tile BYTES are backend-internal handles (WebGL assigns megatextureIndex in priority-queue load order) and are only byte-comparable in the root/single-tile case. Part C (user-customShader gate): a dual-language CustomShader remapping `alpha = 1 - color.a` — the picked cell must be the analytic first INVERTED-filled cell, byte-equal across backends, and the WebGPU pick pipeline must be the `userCustomShader#` variant. Run after touching `fragmentPickVoxelMain` / the pickVoxel pipeline in `WebGPUVoxelRenderer.ts`, the `passes.pickVoxel` routing in `selectCommandVariant`, `WebGPUPickFramebuffer.readCenterPixel` (this probe is what caught its vertical-mirror bug — GL bottom-origin rect row used as a top-down texture row), the voxel shapeUv convention pack, or the depth-1 octree traversal / user-shader pick-gate compose. |
| `probe-voxel-pick-logdepth.mjs` | **Voxel pick log-depth gate (NEW-WEBGPU-VOXEL-PICK-LOG-DEPTH — the C10-11 prerequisite).** Forces the pick-fleet gate ON (`context._pickLogDepthWriteEnabled = true`) and asserts, WebGPU-only: the two voxel PICK descriptors are the `[ld]` log variants with `depthWriteEnabled === true`; `scene.pickVoxel` (cell pick) + `scene.pick` (object pick) STILL return the correct voxel/cell (same voxel picked); a nearer "blocker" voxel correctly OCCLUDES a farther one in the shared pick FBO (positive proof the log frag_depth is written, non-degenerate, monotonic); 0 device/console errors (LOG_DEPTH module + both pick pipelines compiled). The gate-OFF byte-identity is covered by `probe-voxel-pick.mjs` + `probe-voxel-parity.mjs`. Run after touching `fragmentPick{Main,VoxelMain}` / the pick pipeline gate in `WebGPUVoxelRenderer.ts`, `isWebGPUPickLogDepthActive` (`WebGPULogDepth.ts`), or `_pickLogDepthWriteEnabled`. Full 20/500/5,000 km pick-depth-plane consistency is C10-11's gate (whole fleet must be log first). |
| `probe-voxel-octree.mjs` | **Voxel deep-octree traversal gate (VOXEL-OCTREE-LOD + NEW-VOXEL-OCTREE-L2-ASSET-PROBE + NEW-VOXEL-OCTREE-DEEP-TRAVERSAL).** THREE-level procedural box provider (`availableLevels: 3`, 4³ per tile, Y_UP — asset in `Tools/visual-regression/fixtures/voxel-octree-l3.mjs`): the level-2 truth is the thin 16³ diagonal whose conservative downsample is `y === z` at every level (self-similar), giving L1 discriminators (empty-at-8³ / filled-at-root) AND L2 discriminators (empty-at-16³ / filled-at-8³). Expectations are 5-ray pick-ray CONES per cell (center + sampling-window corners; graze/bleed cells auto-skip; median window pixel defeats star dots). CLOSE view (10R) and CLOSE2 view (5R): WebGPU must match LEVEL 2 exactly (≥4 L1 discriminators black at close, all 12/12 L2 discriminators black at close2; internals `slotCount 73`, 8 `childSlots` + 64 `l2Slots` uploaded, `lastTargetLevel 2` at both) — the B17 iterative-walk gate, now standing; WebGL judged per-cell vs L1-or-L2 at close (mixed per-node refinement is legitimate upstream) and strict LEVEL 2 at close2 (proves the asset discriminates). Far view: `lastTargetLevel 0` + small crop diff vs WebGL. The pre-B17 `EXPECT_L2` env toggle is retired — deep traversal is the default gate. Run after touching `tryUploadChildVoxelTiles`/`driveTileLevelUploads`/the atlas allocation (`WebGPUVoxelDataUpload.ts`), the WGSL `octreeDescend` walk / atlas slab addressing, or `computeVoxelTargetLevel` (`WebGPUVoxelRenderer.ts`). |
| `probe-voxel-octree-l3plus.mjs` | **Voxel depth-3 octree traversal gate (NEW-VOXEL-OCTREE-DEEP-LEVELS).** FOUR-level procedural box provider (`availableLevels: 4`, 2³ per tile so the full 585-slot atlas fits `maxTextureDimension3D` — asset in `Tools/visual-regression/fixtures/voxel-octree-l4.mjs`): the level-3 truth is the thin 16³ diagonal, self-similar `y === z` at every level, giving L2 discriminators (empty-at-8³ / filled-at-4³) AND L3 discriminators (empty-at-16³ / filled-at-8³). CLOSE (6R) + CLOSE2 (3.5R): WebGPU must match LEVEL 3 with ≥4 L3 discriminators black (internals `slotCount 585`, 8 `childSlots` + 64 `l2Slots` + 512 `l3Slots` uploaded, `lastTargetLevel 3`); WebGL judged L2-or-L3 per cell at close, strict LEVEL 3 at close2 (proves the asset discriminates). FAR (700R): `lastTargetLevel 0` + small crop diff. Off-gate: `availableLevels ≤ 3` OR the 585-slot set does not fit → the level-2 cap (`probe-voxel-octree.mjs` stays slotCount 73). Run after touching the level-3 allocation / `driveTileLevelUploads` level-3 drive (`WebGPUVoxelDataUpload.ts`), the WGSL `octreeDescend` level-3 branch / `l3Slots` UBO array, or `voxelMaxUploadedLevel`/`computeVoxelDemandLevel` (`WebGPUVoxelRenderer.ts`). |
| `probe-voxel-megatexture.mjs` | **Voxel megatexture upload + streaming + LRU-eviction gate (PARITY-VOXEL-MEGATEXTURE-UPLOAD + NEW-VOXEL-STREAMING-UPLOAD + NEW-VOXEL-ATLAS-LRU-EVICT).** PART 1: VoxelBox3DTiles root-tile REAL-data upload replaced the 4×4×4 placeholder (`usingRealData`, input-orientation texture dims, non-black march). PART 2 (streaming): the 3-level `voxel-octree-l3` fixture on a full 73-slot atlas — FAR camera keeps a root-only atlas (demandLevel 0, zero descendants — the demand-driven discriminator vs the eager path), NEAR camera streams 8+64 tiles to the eager steady state (`childPhase "done"`), RETURN-FAR keeps them resident (under-capacity = the LRU off-gate). PART 3 (eviction): same fixture with `_webgpuVoxelAtlasMaxSlots = 13` (dynamic 4-slot L2 pool) + `screenSpaceError = 100`, camera just outside opposite box corners (±1.05R diagonal): corner A demands ~11 corner-local tiles > pool → exactly 4 resident, no overflow; corner B LRU-evicts the stale A set and reuses slots 9..12; returning to A re-requests/re-uploads the evicted tiles — resident set restored AND the corner-A screenshot pixel-matches the first visit (0 mismatch — correct cell values after re-upload). Run after touching `WebGPUVoxelDataUpload.ts` (capacity calc, `driveDynamicL2Uploads`, `evictLruL2Slot`), `computeVoxelDemandLevel` / `computeVoxelL2DemandMask` (`WebGPUVoxelRenderer.ts`), or the atlas slot layout. NOTE: PART 3 cameras must stay OUTSIDE the box — camera-inside-volume renders black on WebGPU (tracked: NEW-VOXEL-INSIDE-CAMERA-BLACK in DEFERRED_WORK). |
| `probe-voxel-user-customshader.mjs` | **User native-WGSL voxel customShader gate (VOXEL-USER-CUSTOMSHADER).** VoxelBox3DTiles with a USER scalar-ramp customShader carrying BOTH `fragmentShaderText` (GLSL, WebGL leg) and `wgslFragmentShaderText` (WGSL, WebGPU leg) authoring the SAME blue↔red ramp over `metadata.a.r`: asserts footprint IoU ≥ 0.85, avg-color L1 ≤ 90 vs WebGL, WebGPU channel spread > 40 (ramp actually replaced the default gray), the WebGPU color pipeline is the `userCustomShader#<hash>` variant, 0 errors. Run after touching `WebGPUVoxelCustomShaderCodegen.ts`, the `VOXEL_USER_CUSTOM_SHADER` nested ifdef in `VOXEL_WGSL`, or `resolveVoxelUserShaderInfo` / the color-module patch seam in `WebGPUVoxelRenderer.ts`. The default-gray + GLSL-only off-gates live in `probe-voxel-parity.mjs` (Part A neutral-gray gate + Part B's GLSL-only customShader). |
| `probe-voxel-ellipsoid.mjs` | **ELLIPSOID voxel shape gate (NEW-VOXEL-ELLIPSOID-INTERSECT B22 + NEW-VOXEL-ELLIPSOID-SHAPEUV B23).** Procedural single-tile ELLIPSOID provider (oblate radii R,R,0.6R via `globalTransform` scale; shell heights 0..1e6 m; 8³ cells each carrying a DISTINCT color — R=lon index, G=lat index, B=height index) rendered on both backends at an identical oblique camera through a dual-language (GLSL + native-WGSL) unlit `metadata.color` customShader. Gates: (B22) footprint IoU ≥ 0.85 + coverage-area delta ≤ 15% — the shell silhouette is the ellipse, not the box OBB; (B23) ≥ 85% of interior grid cells color-match (RGB distance < 60) with a WebGL-side R+G variance floor proving the lon/lat gradient discriminates — the per-cell pattern IS the radial/longitude/latitude shapeUv mapping; plus real-data upload + the `userCustomShader#` color pipeline + 0 errors. Run after touching `intersectShapeReal`/`intersectEllipsoidHeight`/`ellipsoidShapeUvFromLocal`/`computeShapeUvReal` or the shape-typed UBO packs (`packVoxelShapeIntersect`, `packVoxelSampleFrame`) in `WebGPUVoxelRenderer.ts`, or the ELLIPSOID sampling-convention branch in `WebGPUVoxelDataUpload.ts`. |
| `probe-metadata-multicomponent.mjs` | **VEC2/3/4 property-ATTRIBUTE full-component transport gate (METADATA-MULTICOMPONENT).** Loads `BoxVec3PropertyAttributes` (per-face-constant VEC3 FLOAT32 `_FACE_COLOR`) with `CesiumWebGPUMetadataDebug=true`; the generated `metadataDebugColor` paints the RAW components as RGB — asserts ≥3 authored face colors match on screen (a `.x`-only regression paints dark reds), the generated chunk declares the `vec4<f32>` transport + `metadataValue.xyz` swizzle, and the debug-off scene shows no palette. Run after touching the slot-9 metadata transport (`WebGPUModelMetadata`, `createVertexBufferLayout` slot 9, `MetadataWGSLPipelineStage.constructFromTransport`, or the `MODEL_HAS_METADATA` WGSL blocks). |
| `probe-metadata-mat.mjs` | **MAT3/MAT4 property-ATTRIBUTE full 9/16-component transport gate (NEW-MODEL-METADATA-MAT3-MAT4).** Loads the authored `Specs/Data/Models/glTF-2.0/BoxMat{3,4}PropertyAttributes` cubes (per-face-constant MAT3/MAT4 FLOAT32 whose COLUMN SUMS encode a distinct RGB palette) on BOTH backends with identical cameras: WebGL reads via a GLSL CustomShader (`fsInput.metadata.faceMatN` column sums, UNLIT, `pow(...,2.2)` pre-inverting `czm_linearToSrgb`), WebGPU via `CesiumWebGPUMetadataDebug=true` → the generated `metadataDebugColor`'s identical column-sum paint. Asserts ≥3 faces match the authored palette on EACH backend, per-face means agree cross-backend (a zero-filled tail — the pre-fix 4-of-9/16 transport — shifts every sum far out of tolerance), the generated chunk carries the extended 7-arg `initializeMetadata` signature + references the tail transport element (`metadataValue2.x` MAT3 / `metadataValue3.w` MAT4), `primCache._metadataMatTransport === true`, and the debug-off scene shows no palette. Run after touching the widened slot-9 layout (`createVertexBufferLayout` mode 2 / `_metadataSlotMode`), `MODEL_METADATA_MAT_TRANSPORT` blocks in `ModelPBRComplete.wgsl`, `constructFromTransport`'s matrix path, or the MAT pack in `resolvePropertyAttributeVec4`. |
| `probe-metadata-uint16.mjs` | **Wide-integer (UINT16/UINT32) property-TEXTURE channel-packing gate (METADATA-UINT16-32).** Loads the authored `Tools/visual-regression/assets/PropertyTextureUint16.gltf` (4-stripe quad; UINT16 on channels [0,1], UINT32 on [0,1,2,3]; stripe 1 has a nonzero LOW byte so the little-endian weight-1 contribution is provable). Asserts per-stripe EXACT `pickMetadata` decodes on BOTH backends (the deterministic RGBA8-quantized values — WebGL's own lossy pick convention) and the WebGPU display debug paint red == expected per stripe. Run after touching `buildPropertyTextureUnpack`/`buildUnpackBitsExpr`/`buildScalarFromRawBits` (`MetadataWGSLHelpers.js`), the metadata debug-scalar codegen, or GLSL `unnormalize` in `Scene/DerivedCommand.js` (whose `float(4294967295)` int-literal overflow this task fixed for WebGL UINT32 pickMetadata). |
| `probe-metadata-table-texture.mjs` | **TEXTURE- / IMPLICIT-sourced property-table gate (METADATA-TABLE-SOURCES).** Loads the authored `Specs/Data/Models/glTF-2.0/PropertyTableFeatureIdSources` quads (2×2 feature-ID texture → 4 regions; implicit variant → per-vertex IDs) over a hidden globe. Asserts: the generated chunk samples `featureIdTexture` + `unpackFeatureId` for the texture source (and uses `i32(metadataFeatureId)` for implicit), 4 distinct per-region debug colors match `fract(intensity)` ordering, per-region `scene.pick → ModelFeature.getProperty("intensity")` equals the authored values on BOTH backends, `pickMetadata` for table properties is identical-undefined on both (upstream #12225), and the debug-off scene shows no palette. Run after touching `findPropertyTableForPrimitive`/`resolvePropertyTableLayout` (WebGPUModelMetadata), the table section of `generateMetadataWGSL`, `createFeatureIdGPUTexture`/the binding-27 feature-ID sampler, the late-metadata primCache rebuild, or the `end`/`endAsync`/`_startReadback` pick-readback origin flip in `WebGPUPickFramebuffer.ts` (this probe caught the regular-pick vertical mirror — the color-path sibling of readCenterPixel's C-R9 flip). |
| `verify-vector-3dtile-frs.mjs` | Vector 3D Tiles feature renderer (FR registration + device-error smoke only — does NOT render real Vector3DTile content; see the Vector3DTile verification-gap note above). |
| `probe-error-gate-selftest.mjs` | **Self-test for the WebGPU error/crash gate** (`Tools/lib/webgpu-error-gate.mjs`). Proves the gate catches an injected uncaptured validation error, stays clean on valid work, and ignores `device.destroy()` teardown. Run after touching the gate or either harness's gate wiring. |

### Cross-backend / Sandcastle

| Script | What it does |
| --- | --- |
| `sandcastle-smoke.mjs` | **LOCAL-REQUIRED Sandcastle WebGPU gate (Batch 242).** Loads 3 renderer-pinned WebGPU gallery demos at their standalone URLs (Orbital Catalog → globe + depth plane + compute-instance; Clustered Lighting → glTF + clustered lights, globe off; Point Light Shadows → entities + glTF + cube shadows) and asserts per demo: non-black pixel fraction ≥ ~half the healthy baseline (15.8% / 79.7% / 100% measured 2026-06-12), ≥8 distinct sampled colors, ≥1 WebGPU device created (silent WebGL fallback = FAIL), 0 console/validation/device-loss errors (auto-arms the error gate by patching `GPUAdapter.requestDevice` — Sandcastle demos expose no `window.viewer`). Exists because the DepthPlane MRT bug blanked EVERY Sandcastle demo for ~115 batches while all CesiumViewer-driven probes stayed green. **Cannot run in CI** (no WebGPU adapter on hosted runners) — run it locally before committing anything touching scene-FB passes, the post-process blit chain, MRT attachment states, or the Sandcastle bootstrap. Captures land in `output/sandcastle-smoke/*.png`. |
| `cross-backend-sandcastle-runner.mjs` | Runs Sandcastle demos on both backends, diffs results |
| `sandcastle-batch-66-final-runner.mjs` / `-end-of-session-runner.mjs` | Batch-specific Sandcastle runners (historical predecessor: `archive/sandcastle-batch-66-runner.mjs`, archived 2026-08-16, M1) |
| `analyze-cross-backend-report.mjs` | Post-process the cross-backend report |

#### Booting a gallery demo standalone in a probe

Gallery `.html` files (`Apps/Sandcastle/gallery/*.html`) reference `../Sandcastle-header.js`, `../load-cesium-es6.js`, and `../templates/bucket.css`, which **404 when served standalone on :8080** (they only exist inside the Sandcastle2 build context, which extracts the `//Sandcastle_Begin…End` block and runs it in a booted iframe). So a demo's own `window.startup` is defined but never auto-called, and `cross-backend-sandcastle-runner.mjs` times out on the canvas wait. To verify a demo in a custom probe, replicate the boot (see `probe-weather-inspector.mjs`):

1. `page.addInitScript` a minimal `window.Sandcastle` stub whose `finishedLoading()` clears `document.body.classList.remove("sandcastle-loading")` + hides `#loadingOverlay` (bucket.css is 404, so do it directly).
2. `goto` the demo URL, then `page.addStyleTag` the sizing bucket.css normally provides: `#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%}`.
3. `page.evaluate`: `const C = await import("/Build/CesiumUnminified/index.js"); window.Cesium = C; await window.startup(C);` — call the demo's OWN startup with the injected Cesium.
4. `armWebGPUDevices(page)`, wait for `window.viewer`, let the render loop settle, then **compositor `page.screenshot`** (not toDataURL — see the cross-backend capture pitfalls in the Visual artifact playbook).

Note: `sandcastle-smoke.mjs` loads 3 renderer-pinned WebGPU demos at their standalone URLs successfully without this shim (it patches `GPUAdapter.requestDevice` for the error gate) — those demos happen to bootstrap; use it as the reference for the demos it covers, and the recipe above for new demos that don't.

Gallery demo `.html` is eslint-linted **as a module**: no top-level `"use strict"`, add `/* global Cesium, Sandcastle */`, `eqeqeq` (no `== null`), `prefer-template`. The old committed demos are grandfathered; new ones must pass.

### Inventory backfill 2026-08-07 (docs-reconciliation pass)

These probes shipped during the 2026-07-23 → 2026-08-06 window and were never entered above, against this file's own standing rule ("**MUST be kept in sync whenever you add a new CesiumDebug command, probe, or globe-fragment debug mode.** A guide that drifts becomes worse than no guide"). They are grouped here rather than filed into the topical tables so this backfill lands as one contiguous block; **move each row up into its subject table when you next touch that section.**

| Probe | Subject table it belongs in | What it covers |
| --- | --- | --- |
| [probe-sun-shadow-gate.mjs](../Tools/visual-regression/probe-sun-shadow-gate.mjs) | Shadows / CSM | **The gate that produced the window's highest-severity engine finding** (`NEW-WEBGPU-GLOBE-SUN-SHADOW-RECEIVE-DEAD`: WebGPU globe drop 0.00 against WebGL 20.17 — fixed Batch 849, re-measured at ratio **1.00** Batch 850). Sun at +30°, nadir camera **2600 m** with `maximumDistance` **10000** — both deliberate, because `ShadowMap.maximumDistance` defaults to 5000 m and the cascaded receive shader returns early past the last cascade, so a camera at regional altitude makes the whole toggle a pixel-exact no-op (that is what wasted the Batch-805 attempt). CAST_ONLY slab over a RECEIVE_ONLY globe, per-cell **A/B/A** control (off → on → off; the cell goes STRUCTURAL if the two off frames disagree), both `DAY_UNLIT` and `DAY_LIT`, clock-solved elevations verified against the sun the engine actually rendered with. Exits 0/1/2/3. **Reuse its framing rather than re-deriving one** — the WebGL-reference discipline is what made the Batch-845 measurement like-for-like. |
| [probe-globe-pipeline-readiness.mjs](../Tools/visual-regression/probe-globe-pipeline-readiness.mjs) | Pipeline / shader / device | Does the WebGPU globe's **async pipeline-resolution skip** produce user-visible holes on a healthy event loop, and does WebGL diverge? A tile whose pipeline variant is not already resident is **not drawn at all** that frame — `resolveGlobePipelineEntry` calls `getPipelineSync` (a pure `cache.get`, never creates), returns null on a miss, and the renderer hits `if (!pipeline) { continue; }`. WebGL has no analogue (`ShaderProgram` compiles synchronously on first use). Reach for this before blaming terrain/imagery for transient WebGPU-only holes. |
| [probe-env-background-clear.mjs](../Tools/visual-regression/probe-env-background-clear.mjs) | Environment / sky / sun / atmosphere | `NEW-WEBGPU-ENV-PASS-DROP` (background-clear member). Measures the **background control response** — black vs white `scene.backgroundColor`, normalized 0..1 — with all environment content hidden and progressively removed, WebGL as the reference at every step. Gates the zero-frustum hole where `WebGPUContext.clear` drops the background `ClearCommand` on the deferred-canvas-clear path and nothing ever wrote `_clearColor`, so `endFrame`'s present fallback ships transparent black. |
| [probe-webgpu-model-shadow-command-graph.mjs](../Tools/visual-regression/probe-webgpu-model-shadow-command-graph.mjs) | Shadows / CSM | C11-184 runtime companion to the focused unit specs. Inspects commands **at the PVS boundary** — after Model emits its native WebGPU command graph but before frustum binning can hide a malformed variant. Covers every `ShadowMode` plus a global OFF→ON→OFF sweep, native caster layout completeness, that pick/metadata-pick/velocity/silhouette/IDL/edge variants never inherit shadow semantics, zero dedicated UB allocation while shadows are off, b3dm translucent-twin cast/receive rules, and RTE-encoded model-space matrices on the buffer actually bound by the cast command. **Runs against a frozen bundle — it does not build or start a server.** |
| [probe-cloud-temporal-rte.mjs](../Tools/visual-regression/probe-cloud-temporal-rte.mjs) | Specific subsystems (clouds) | C13-05 temporal-history/RTE acceptance. **Deliberately separate from `probe-cloud-temporal.mjs`**, which stays a visual smoke check — this one certifies the production history state machine by observing the exact 60-float upload to `"CloudTemporalResolve UB"` (slots 55 first-frame flag / 56 generation / 57 reset-reason mask / 58 frame number). One deterministic session covers seed→continuous acceptance, bounded translation/pan without reset, >50 km teleports, antimeridian crossing, both poles, orbit, temporal↔non-temporal re-entry, deck topology changes, target resize, and look-away cull re-entry. |
| [probe-cloud-density-domain.mjs](../Tools/visual-regression/probe-cloud-density-domain.mjs) | Specific subsystems (clouds) | C13-37 baked-density periodicity oracle, WebGPU-only. Same-build legacy/new × baked/live × midpoint/IGN factorial, flipping only `qualityFlags` bits 0/3/13 **after** the cloud renderer has packed and uploaded slot 74. **Fails closed** unless the renderer is recording into Scene's main command encoder (otherwise an orphan encoder may already have been submitted and the override lands too late). Visual-quality characterization **only — not performance evidence**, and it certifies nothing about temporal history, weather seams, cloud shadows, masks, or capture paths. |
| [probe-cloud-ibl-optout-revision.mjs](../Tools/visual-regression/probe-cloud-ibl-optout-revision.mjs) | Specific subsystems (clouds) | C13-38 runtime gate — cloud animation must not refresh dynamic-environment resources while the full reflected-cloud march is opted out. Holds every other refresh input stable, advances only the publisher-owned cloud revision, and asserts: opt-out leaves the revision unconsumed; opt-in consumes the newest and enables the full march; ON→OFF performs exactly one teardown refresh; later opt-out revisions stay unconsumed until the next opt-in. Records source/build provenance (SHA-256 of the manager source + bundle + source map) so a stale bundle cannot pass silently. |
| [probe-cloud-reconstruction-attachments.mjs](../Tools/visual-regression/probe-cloud-reconstruction-attachments.mjs) | Specific subsystems (clouds) | C13-09 Edge acceptance for the reconstruction ATTACHMENT set (certified green Batch 936, 17/17). Toggles `CesiumDebug.cloudReconstructionAttachments`, reads the active-window counters (produced / targets 3 / generation / `liveBytes === w*h*24` / pass encoded once), proves same-page OFF→ON→OFF byte identity at the frame's stationary fixed point, and rides a resize for the monotonic generation. **Its cross-build arm is the reference method for "byte-identical to the pre-change build"**: cross-PAGE captures of one build differ (temporal history freezes initialization variance into a per-page fixed point), so the arm is a cross-build pixel diff bounded by the same-build cross-page floor measured in the same run. `PRE_BASE` selects the pre-change server; omitting it makes the arm STRUCTURAL rather than silently absent. |
| [probe-cloud-reconstruction-consume.mjs](../Tools/visual-regression/probe-cloud-reconstruction-consume.mjs) | Specific subsystems (clouds) | C13-10 Edge acceptance legs B/C/D — the march-EMITTED depth and its first consumer. **Leg B** flips `CesiumDebug.cloudReconstruction(true)` in the march-active window and requires `requested`/`emitted`/`consumed` true with `producerTargets` **measured at 3 in the attachments-only state and 2 under consume, in ONE page** (the counter that proves ownership of the depth slot moved), `liveBytes` unchanged at `w*h*24`, and the cloud pass topology unchanged. **Leg C** rides a resize (monotonic generation, `liveBytes` tracking size, `consumed` back inside a bounded window) and a low→high→low tier flip (the full-resolution tier produces nothing — the documented residual); **device loss is out of scope by design** and is covered as a unit in `cloud-reconstruction-attachments.spec.mjs` B3/B4. **Leg D (`--perf`)** is the interleaved A/B cost lane under the mandatory C13-39 protocol: N iterations of one attachments-only and one consume-on window with the ORDER alternating, `ProceduralClouds half-res pass` and `CloudReconstructionAttachments pass` reported separately (plus the resolve, and the upscale as a drift control), per-arm medians and PAIRED per-iteration deltas. **No pass/fail bar on timing or on the visual delta on the first run** — the diffs and PNGs are recorded for reading; an adapter without timestamp support is STRUCTURAL by name, never a zeroed table. A run without `--perf` exits 3 and says Leg D did not run. Its structure is pinned by `cloud-reconstruction-consume-probe.spec.mjs`. |

> **Correction to the `probe-vector-draping.mjs` note earlier in this section (added 2026-08-07).** That note ends "gate B now fails in the OPPOSITE direction on a pre-existing WebGL-side extent (`NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT`, LOW)". **That is superseded — gate B PASSED at Batch 842** after the Batch-841 rebuild: both backends measure the identical nadir bbox `[451,19,584,747]` (delta **0**), counts 22396 vs 22397, gates A/C/D/E all PASS. `NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT` is RESOLVED; **gate F (non-regression, STRUCTURAL pending a pre-change cross-build baseline) is the only leg still owed.** The note's closing rule is UNCHANGED and still binding: **the bbox predicate is symmetric and must NOT be flipped to a one-sided test** — it was never loosened, and it is what measured every step of 199 → 103 → 0.

### Load-bearing instruments missing from the tables above (added 2026-08-09, handover audit FIX 36)

These five carry campaign acceptance and were absent from this guide entirely — a successor hunting for "the instrument that certifies X" would have concluded none existed and written a rival probe.

| Instrument | What it certifies |
| --- | --- |
| [probe-ground-fog.mjs](../Tools/visual-regression/probe-ground-fog.mjs) | The ground-fog arm — the fog band's presence and extent on both backends. Its acceptance is still owed to the machine lane; pair it with `ground-fog-band.spec.mjs` below, which is the offline half. |
| [probe-timedynamic-pointcloud-load.mjs](../Tools/visual-regression/probe-timedynamic-pointcloud-load.mjs) | Time-dynamic point-cloud loading — the streaming/keyframe path that no other probe exercises. |
| [sun-radiance-delta.spec.mjs](../Tools/visual-regression/sun-radiance-delta.spec.mjs) | `C12-19`'s delta lane — the NO-EXCESS check on live captures whose second run (Batch 994, `0697b93a5b`) discharged the Edge-delta obligation open since Batch 947. |
| [webgpu-sun-bloom-mirror.spec.mjs](../Tools/visual-regression/webgpu-sun-bloom-mirror.spec.mjs) | `C12-34`'s mirror — the WebGPU bright-pass bloom pinned to the shipped WebGL text (both shader bodies executed as JavaScript and required to agree to 1e-15, naga on both WGSL files, off-is-off, two mutants). |
| [ground-fog-band.spec.mjs](../Tools/visual-regression/ground-fog-band.spec.mjs) | The ground-fog band's offline contract. ⚠ Also the file where `C16-07`'s widened anchor sweep found **two live spec anchors into comment text**, one of them an `indexOf` used as a block locator — read it before rewriting comments in the fog path. |

### Inventory backfill 2026-08-14 — the Sol 5.6 week (fix SOL-12; audit finding S22)

**48 new instruments landed in `cff0b76a2f..034c7f74d0` and NONE of them were entered in this guide** — the same standing-rule breach the 2026-08-07 backfill above records, at four times the size. They are listed here as one contiguous block; **move each row up into its subject table when you next touch that section.** Counts are census-derived: `git diff cff0b76a2f..034c7f74d0 --diff-filter=A --name-only -- Tools/visual-regression` yields 15 new `probe-*.mjs` and 33 new `*.spec.mjs` (plus harnesses, 18 `lib/` modules, the NASA fixture directory, and two JSON workload/provenance files that are data, not instruments). Re-derive rather than trusting these numbers.

⚠ **READ BEFORE RUNNING ANY OF THE S5 PROBES.** Per audit findings S4 and S5 of [SOL_WEEK_AUDIT_2026-08-14.md](SOL_WEEK_AUDIT_2026-08-14.md), the **fleet-contract gate is RED at HEAD and structurally dark**:

- All six `probe-c12-29-s5-*.mjs` probes carry **reject-only timers, not terminating watchdogs** — `process.exitCode` cannot force exit on a wedged loop — and they **leak the browser** (no close, or a close outside `finally`). They are not allowlisted; they were left failing, so `probe-fleet-contract.spec.mjs` can no longer catch the NEXT violation. Two pre-existing probes also regressed.
- The S5 architecture is **thin-probe / fat-lib**: every exit semantic lives in `lib/*-gate.mjs`, which the fleet contract **never scans**. Demonstrated consequence: `lib/c12-29-s5-custom-ellipsoid-gate.mjs` routes STRUCTURAL to **exit 2**, which is crash-indistinguishable and violates the 0/1/2/3 doctrine.
- Capture doctrine is in conflict in-repo (finding S15): **zero of the eight new browser probes use Playwright element screenshots**, five bypass the shared capture home, and `probe-moon-globe-depth-occlusion.mjs` uses the deprecated `drawImage`→`getImageData` reader on WebGPU (mitigated only in that its banked run is demonstrably non-vacuous). Reconcile [ORCHESTRATION_HANDBOOK.md](ORCHESTRATION_HANDBOOK.md) §7 against `lib/same-task-capture.mjs` **first** — fix SOL-9 — then re-judge these probes.

Fix SOL-5 owns the watchdog/close repair and extending the contract to `lib/*-gate.mjs`. Until it lands, treat a green run from these probes as unverified.

**New browser probes (15).**

| Probe | What it covers |
| --- | --- |
| `probe-c11-13-voxel-inside-camera.mjs` | `C11-13` inside-the-proxy voxel rendering. Thin entry point over `lib/c11-13-voxel-inside-camera-probe.mjs`; asserts its outer watchdog loses to the artifact watchdog. **Closure band is loose — audit S17: IoU ≥ 0.6 against an observed 0.994, and the banked PNGs show a real cross-backend stipple artifact (WebGPU dithered corner vs uniform WebGL fill) that a mean metric with 150× headroom cannot flag.** |
| `probe-c11-168-direct-model-ablation.mjs` | `C11-168` fresh-process direct-model causal discriminator. Two reverse-order quartets; every leg spawns its own Node runner and its own fresh Edge, 600-frame resident route, API instrumentation and GPU timestamps OFF. |
| `probe-c11-169-primitive-breakdown.mjs` | `C11-169` Tools-only nested primitive-traversal CPU discriminator. Nests four instance-local timers inside the coarse 11-phase schema (`primitiveTraversal` = ground + ordinary + globe render + residual). Wrappers live only in the probe and are restored exactly; **diagnostic, not a performance verdict.** |
| `probe-c11-193b-shared-submit.mjs` | `C11-193B` dynamic-IBL frame-encoder / shared-submit acceptance. Observation-only wrappers installed at native WebGPU boundaries **before** the viewer boots; three lanes (no-refresh control, two same-topology refreshes in one frame, one accepted topology replacement plus its follow-up frame). |
| `probe-c11-193c-demand-priority.mjs` | `C11-193C` same-frame demand priority and bounded drain. Proves HIGH-before-NORMAL admission, lossless bounded deferral, MANDATORY-plus-one-deferrable budget semantics, late split-2D promotion on the continuation encoder. **Not a timing probe** — it observes pass/encoder/command-buffer/submit shapes. |
| `probe-c11-209-effects-placeholder-startup.mjs` | `C11-209` startup acceptance for the effects depth placeholders. Native wrappers installed before Cesium requests a device; attributes only the exact initialization encoder/command buffer. Needs the dev server already on `:8080`. |
| `probe-c11-90-primitive-restart-split.mjs` | `C11-90` historical entry point retained for evidence continuity only. The Split UI is not an authority on Sandcastle standalone routes, so the real work moved into `lib/c11-90-primitive-restart-probe.mjs` driving strict WebGL2 and WebGPU pages in a Tools-only harness. |
| `probe-c12-29-s4-orbital-sunrise.mjs` | `C12-29` **S4** orbital-sunrise acceptance (COMPLETE / EDGE VERIFIED, run `6a3eac44`). Two fresh contexts over a 400 km circular-orbit sunrise; the certifying blend-neutral lane holds atmosphere radiance below one output code so `Sun.js` still computes extinction while every other destination contribution is hidden. 181 one-second samples; render and `toDataURL` in **one page task**, no canvas-copy path. |
| `probe-c12-29-s5-custom-ellipsoid.mjs` | **S5** custom-oblate-ellipsoid runtime certification. Serial fresh WebGL then WebGPU; write-once artifacts, mutable latest replaced only under byte-exact RUNNING authority. ⚠ **Fleet-contract RED. Two banked runs, both ERROR/exit 2, zero PASS.** Its gate lib routes STRUCTURAL to exit 2 (S5) and its spec reports build-absence as a product FAIL rather than STRUCTURAL (S22); audit S11 records three undeclared loosenings in the v7 hardening. |
| `probe-c12-29-s5-dense-cost.mjs` | **S5** dense ACTIVE/INACTIVE cost characterization. Coordinator spawns 24 child Node processes in frozen order, one fresh Edge and one 600-frame condition each. Requires certified terrain-v10 + NASA-SVS-v4 manifests, a current `Build/CesiumUnminified`, and a running loopback server; builds nothing. The dense-cost gate is a **real timing instrument** (audit countervailing: no count-for-timing). ⚠ **Fleet-contract RED; never executed in a browser — zero banked runs.** |
| `probe-c12-29-s5-multiview.mjs` | **S5** same-context logical-View / stereo policy certification. The A→B→A lane is deliberately Tools-owned — production `Scene.render` restores `_defaultView`, and the probe does not pretend Cesium has an arbitrary-View scheduler. Also exercises the real offscreen ray View, WebGL's two-eye VR executor, and WebGPU's synchronous unsupported-path rejection. ⚠ **Fleet-contract RED; zero banked runs.** |
| `probe-c12-29-s5-replacement-device.mjs` | **S5** replacement-device recovery. The only loss trigger is Chromium's normal GPU-process termination hook via `--enable-gpu-benchmarking`; it never calls `GPUDevice.destroy` and never invokes a crash hook, and a loss whose reason is `destroyed` is archived STRUCTURAL, never counted as recovery. ⚠ **Fleet-contract RED; zero banked runs.** |
| `probe-c12-29-s5-svs-footprint.mjs` | **S5** absolute NASA-SVS 5073 geospatial-footprint acceptance against the vendored four-row fixture + local QuantizedMesh. Never fetches the network, recentres a result, builds, or starts a server. ⚠ **Fleet-contract RED. One banked run, ERROR/exit 2, zero PASS.** Its spec takes **27.6 min** to run (S22), and the v5 repair in the working tree is **paused and independently REJECTED** (handoff §4) — do not run or freeze it without the re-review. |
| `probe-c12-29-s5-terrain-selection.mjs` | **S5** real-terrain/selection acceptance over the local QuantizedMesh fixture. Per session: ellipsoid control, first-`beginFrame` provider reset, a genuine single-held-request `TerrainFillMesh`, fill-to-real transition, exact ×2 radius law, real awaited async picking, fresh-provider reset; WebGPU additionally drives retained six-face capture through a Model's normal `DynamicEnvironmentMapManager` update (WebGL records N/A). **The only S5 lane with a PASS** — run `83aea7d0-7c8e-4543-8818-7cc459cb01c3`, 1 of its 12 banked runs. ⚠ Fleet-contract RED. |
| `probe-moon-globe-depth-occlusion.mjs` | `C12-37` Moon/globe physical-depth oracle. Deliberately does **not** trust the supplied screenshot as geometry — that saved view runs first and MUST classify STRUCTURAL (the Moon is wholly behind the camera at the recorded clock). Certifying lanes are derived from the live ICRF Moon centre: `moon-near`, `earth-near`, `crossing`. ⚠ Uses the deprecated `drawImage`→`getImageData` reader on WebGPU (S15); its banked run is non-vacuous, but do not copy the reader. |

**New offline specs (33, `node --test`).** Test counts are as measured at this backfill; re-derive rather than citing them.

| Spec | What it pins |
| --- | --- |
| `c11-13-public-voxel-pick-convergence.spec.mjs` (3) | Public voxel pick convergence contract for `C11-13`. |
| `c11-13-voxel-inside-camera-probe.spec.mjs` (13) | Structure of the inside-camera probe itself — watchdog ordering, artifact shape. |
| `c11-13-voxel-pick-pipeline-name.spec.mjs` (5) | The voxel pick pipeline-name binding (the aliasing hazard `CLAUDE.md` warns about). |
| `c11-146-route-evidence.spec.mjs` (12) | `C11-146` fail-closed route assessor (Batch 1027) — pairs with `assess-c11-146-route.mjs`. |
| `c11-168-direct-model-ablation-policy.spec.mjs` (14) | Ablation-discriminator policy: quartet ordering, fresh-process isolation, instrumentation-off invariants. |
| `c11-205-owner-attribution-policy.spec.mjs` (16) | Resident-owner attribution policy for the campaign runner. |
| `c11-209-effects-placeholder-provenance.spec.mjs` (7) | Browser-provenance binding for the effects placeholder startup packet. |
| `c11-90-primitive-restart-harness.spec.mjs` (12) | The Tools-only primitive-restart harness contract (offline; the demo is pinned offline by `51b2c34eab`). |
| `c12-29-s4-orbital-sunrise-gate.spec.mjs` (32) | S4 gate library. ⚠ **S22: does build I/O at import time, so a missing build fails the whole file rather than one test.** Move that into the test body. |
| `c12-29-s5-custom-ellipsoid-gate.spec.mjs` (102) | S5 CUSTOM v7 gate library — the largest new spec (5,958 lines). ⚠ **201/204 in the main tree** (build absent, reported as product FAILs — S22); one deterministic failure (watchdog cleanup does not throw) corroborates S4. |
| `c12-29-s5-dense-cost-gate.spec.mjs` (40) | S5 dense-cost gate library, incl. the budget function that throws if a frozen input widens. |
| `c12-29-s5-multiview-gate.spec.mjs` (44) | S5 multiview/stereo gate library. |
| `c12-29-s5-replacement-device-gate.spec.mjs` (19) | S5 replacement-device gate library; STRUCTURAL classification of `destroyed` losses. |
| `c12-29-s5-svs-footprint-gate.spec.mjs` (57) | S5 NASA-SVS gate library. ⚠ **Runs 27.6 minutes** — do not put it in an inner loop. |
| `c12-29-s5-terrain-selection-gate.spec.mjs` (41) | S5 terrain-selection gate library (6,207 lines); the lifecycle authority the one PASS ran under. |
| `cpu-frame-accounting.spec.mjs` (16) | Whole-scene CPU accounting contract (`c404c3de04`). |
| `cpu-primitive-breakdown-policy.spec.mjs` (17) | Nested primitive-breakdown policy for `probe-c11-169-primitive-breakdown.mjs`. |
| `cpu-scene-phase-integration.spec.mjs` (5) | Scene-phase integration of the CPU accounting seam. |
| `eclipse-high-precision-dependency.spec.mjs` (8) | The pinned high-precision ephemeris dependency (`9def755e43`) and its lazy-import module edge (`bc438639ad`). |
| `eclipse-sandcastle.spec.mjs` (10) | The Sandcastle2 Eclipse Explorer demo (`3664031397`, `b31529a0c0`). ⚠ **S22: `Cesium.EclipseDiscGeometry` is exported unusable — the factory and enum are not in the barrel.** |
| `environment-refresh-priority.spec.mjs` (10) | `C11-193C` demand-priority/bounded-drain policy. ⚠ **S22: env-map ticks are droppable when the drain is skipped.** |
| `model-primitive-topology-sandcastle.spec.mjs` (3) | Primitive-restart demo topology + its offline pin. |
| `moon-globe-depth-routing.spec.mjs` (32) | `C12-37` physical-route selection, `Pass.OPAQUE` participation, octree/Hi-Z exclusion, legacy-route byte identity. |
| `moon-mip-motion-certification.spec.mjs` (15) | `C12-33` contract/finalizer. ⚠ **Audit S14 (MED): UNSOUND AS TITLED** — nothing measures mip level across motion, the calibrated gate cannot fail (its thresholds are min/max envelopes of the same five runs they judge; a 4.5× injected outlier simply widened its own bar), and sensitivity has no minimum effect size (1e-15 passes). Fix SOL-10 owns the re-scope. |
| `nasa-svs-5073-umbra-fixture.spec.mjs` (7) | Deterministic shapefile reconstruction/parse of the vendored four-record `umbra_lo` subset — 7/7 over 687 stored / 683 non-closing vertices. Pairs with `.gitattributes` (finding S21). |
| `visual-evidence-library.spec.mjs` (35) | The immutable publication library's contract. ⚠ **S19 / maintainer ask R-e: `lib/visual-evidence-library.mjs` (3,252 lines) imports zero project modules and nothing in the pipeline consumes it** — a parallel evidence stack sharing a wire format by duplicated string literal. Adopt-or-remove is a maintainer call. |
| `voxel-inside-camera-policy.spec.mjs` (6) | Inside-camera voxel rendering policy. |
| `voxel-megatexture-reupload-policy.spec.mjs` (8) | The megatexture re-upload oracle (`f54d58cdd4`) as policy. |
| `webgpu-cloud-shadow-bind-group-cache.spec.mjs` (3) | `C11-60` cloud-shadow bind-group caching (Batch 1019). |
| `webgpu-frame-accounting-policy.spec.mjs` (10) | WebGPU frame-accounting policy for the CPU lane. |
| `webgpu-pick-center-identity.spec.mjs` (9) | Center-pixel pick identity. ⚠ **S13: readback starvation is REAL and unfixed — only the last-armed request per frame can publish, so multi-property `pickMetadata` in one task returns `undefined` forever for all but the last.** |
| `webgpu-pick-miniframe-clear-guard.spec.mjs` (3) | The standalone-pick-frame clear-budget reset (`8a9178d99c`). |
| `webgpu-voxel-resource-lifecycle.spec.mjs` (12) | `WebGPUVoxelResourceLifecycle`. ⚠ **S6(c): a failed voxel root upload THROWS out of `Scene.render` on WebGPU where WebGL raises `tileFailed` and keeps rendering** — an error-path parity inversion, open under fix SOL-6. |

**Uncommitted at the time of this backfill (11).** These existed only in the working tree when the audit ran (Lane F); three of them are the **HOLD-FOR-SOL** paused packets and must not be run, reviewed, or landed as if frozen — see [HANDOFF_2026-08-14_CODEX_PAUSE.md](HANDOFF_2026-08-14_CODEX_PAUSE.md) §4–6.

| Instrument | Status |
| --- | --- |
| `c12-11-star-catalog-gate.spec.mjs` (23 top-level / 67 total) | `C12-11` star-catalog harness contract (rebuilt 2026-08-21, station-3 reviewed): UUID-bound write-once evidence, checks A-G, four Batch-837 PNGs pinned immutable. The C12-11 ROW stays HELD (ten architecture blockers); the harness cannot produce PASS until an eligible both-backend G3 PASS report exists. |
| `c12-31-aureole-gate.spec.mjs` (22) | **HOLD-FOR-SOL.** `C12-31` L1–L4 aureole core; independent review **NO-GO** on eight findings; only the gate lib was mid-repair at the pause, so the tuple is mixed and must not be tested as the earlier freeze. |
| `cloud-morphology-composition.spec.mjs` (14) | Cloud morphology/composition offline contract (C13 lane). |
| `cloud-u2-perf-evidence.spec.mjs` (16) | `C13-16` U2 cross-bundle GPU-timestamp evidence contract. |
| `finding-ownership-audit.spec.mjs` (9) | Audits that every banked non-PASS finding has a declared owner — the offline half of [FINDING_DISPOSITIONS_2026-08-13.json](FINDING_DISPOSITIONS_2026-08-13.json). |
| `model-lazy-pick-demand.spec.mjs` (13) | `C11-196` lazy model pick-resource realization. |
| `pointcloud-voxel-public-correctness.spec.mjs` (26) | Public point-cloud/voxel correctness surface (C18 lane). |
| `probe-c11-196-lazy-pick-demand.mjs` | Browser discriminator: model pick resources stay cold during colour rendering, realize synchronously on first pick demand, stay stable. |
| `probe-c11-202-batchtexture-pick-demand.mjs` | Ordinary native model picking must not realize the legacy `BatchTexture` pick registry/texture first; WebGL authoritative. |
| `probe-c11-210-compute-command-list.mjs` | `C11-210` — builds the real native command through the context-private `_computeCommandClass` factory and lets a custom primitive append it to the Scene command list. |
| `probe-cloud-u2-perf.mjs` | `C13-16` U2 cross-bundle GPU-timestamp no-regression gate (baked march, LIVE escape, single + cascaded cloud shadow maps, environment/IBL leg). |

**Supporting files that are not instruments** and are listed so nobody hunts for them as probes: `assess-c11-146-route.mjs`; the harnesses `c11-13-voxel-inside-camera-harness.{html,mjs}`, `c11-90-primitive-restart-harness.{html,mjs}`, `c12-29-s5-custom-ellipsoid-harness.html`; 18 new `lib/*.mjs` gate/probe libraries (**the fleet contract does not scan these — finding S5**); `fixtures/nasa-svs-5073/` (four vendored shapefile members + `manifest.json` + `NOTICE.md` + two `.mjs` tools); `fixtures/astronomy-engine-2.1.19-provenance.json`; `performance-workloads-s5-dense-cost.json`; and `visual-evidence-library.mjs`.

### Instrument doctrine

The verification and instrument rules earned on 2026-07-25 and 2026-08-08 — same-task capture, canvas-element PNGs, pinned clocks, helpers inside `page.evaluate`, interleaved A/B for GPU timing, reference-disagreement = STRUCTURAL, and the WebGPU-canvas capture rule (Playwright element screenshots ONLY; in-page `drawImage` reads transparent even in the same task) — are banked in **[ORCHESTRATION_HANDBOOK.md](ORCHESTRATION_HANDBOOK.md) §7 (Verification and instrument doctrine)**. That is the authority; this guide covers tools and procedures, the handbook covers method. Read it before building any new probe.

### Instrument-defect case files

Two investigations are kept as *case files* rather than as runnable gates. Both times a capture artifact was mistaken for a render bug; both times the discriminating test cost less than the fix that was about to be written. The files themselves are historical artifacts and may move under `archive/` — the lesson is the part that has to survive.

**Far-camera "cage" / "ring" — [probe-farcam-isolation.mjs](../Tools/visual-regression/probe-farcam-isolation.mjs)**

- *Symptom:* at 12/20/35/50 Mm, WebGPU showed dark radial wedge-gaps and ring bands across the globe disc that WebGL did not — captured while `scene.globe.tilesLoaded` was already true and coverage was past 25%.
- *False conclusion invited:* an RTE/precision defect at far camera distances — plausible because the genuine far-camera mesh tear (a real precision bug, fixed by the RTC switch) sat in the very same sweep.
- *Discriminating test:* re-run one view at a time with a **long fixed settle and no early break** (600 warm-up frames, then 400 per view) on both backends, so every capture is taken at full materialization, then compare only fully-materialized frames.
- *Result:* the cage rendered clean. It was a partially-materialized capture — WebGPU pipelines were still compiling behind a readiness signal that had already flipped true.
- *Doctrine:* **a readiness flag is not a readiness proof.** Settle on a measured property of the thing you are about to photograph, and when two artifacts share one sweep, isolate before attributing.

**12 Mm coarse-LOD gaps — [probe-h12-longsettle.mjs](../Tools/visual-regression/probe-h12-longsettle.mjs)**

- *Symptom:* the same 12 Mm cage, reproduced on WebGPU alone at the exact saved view.
- *False conclusion invited:* level-0/1 tiles whose shared edges disagree — i.e. a real geometry/skirt defect in the WebGPU terrain path.
- *Discriminating test:* one page, one view, two settles differing in exactly one variable — short (60 frames, mimicking the original probe's early break) and long (600 frames) — capturing after each while logging the **rendered tile-level histogram** at frames 30/100/250/last, so the LOD state is measured instead of assumed.
- *Result:* the histogram shifted to finer levels and the gaps filled in; `tilesLoaded` had gone vacuously true on WebGPU long before refinement finished.
- *Doctrine:* **instrument the state your hypothesis is about.** A probe that photographs the scene without recording the scene's own LOD/pipeline state cannot separate a render bug from a timing bug.

---

## Running the Karma spec suites (C11-132 / C11-134, 2026-08-07)

**The manual spec-bundle workaround is retired — do not copy it into new guides.** Every prior execution guide opened with "run `npm run build --workspace @cesium/engine` FIRST (spec-bundle freshness trap)". That workaround existed because `gulp test --workspace engine` serves `packages/engine/Build/Specs/SpecList.js` while the task rebuilt only the ROOT `Build/Specs` bundle, so a brand-new package spec could stay out of the served bundle and "pass" by never running (and a deleted spec could keep running from a stale one).

The trap is now closed in the task itself:

- The spec-list generators stamp `SpecList.meta.json` beside each built bundle, recording a **content digest** of the exact spec source set they bundled (content, not mtime — a git checkout resets mtimes).
- `gulp test` recomputes that digest for the lane it is about to serve (`engine`, `widgets`, or the ROOT `combined` bundle), rebuilds **only the spec bundle** if it drifted, and re-verifies. A matching digest rebuilds nothing, so the inner loop stays fast.
- If a rebuild still leaves the bundle stale, the task **fails loudly and names the exact files** — added ("never bundled — would silently not run"), removed ("deleted but still bundled"), and content-changed.
- The workspace lane now builds the workspace (`buildEngine` / `buildWidgets`), which is what actually produces the bundle and the workers it serves.

Sources: `scripts/specBundleFreshness.js`, the `test` task in `gulpfile.js`, guard `scripts/__tests__/specBundleFreshness.spec.mjs` (`node --test`).

**Offline lane is the default (C11-134).** This sandbox has no reliable outbound network, so a spec that reaches Ion / Cesium World Terrain is nondeterministic — it times out, or passes only when the network happens to be up, and neither is a truthful count for the C11-137 exit gate.

- Suites that genuinely need a live service are declared with `describeRequiresNetwork()` (`Specs/networkPolicy.js`). Offline they are **skipped with the recorded reason `"requires network"`** — a truthful skip, not a silent pass. Their names are on `window.__cesiumSkippedNetworkSuites`.
- A fetch/XHR guard refuses any request to a host other than the Karma origin, records it on `window.__cesiumBlockedNetworkRequests`, and fails **loudly** with the offending URL and the remedy. A newly-added network dependency therefore fails the day it lands.
- Run the online lane with `npx gulp test --no-offline` — coverage is quarantined, never deleted.
- Currently quarantined: `Core/createWorldTerrainAsync`, `Core/TerrainPicker`, and the `with CesiumWorldTerrain` blocks of `Core/sampleTerrain` and `Core/sampleTerrainMostDetailed`. The Ion specs that mock their transport (`Core/IonResource`, `Scene/IonImageryProvider`, `Scene/createWorldImageryAsync`, `Core/GoogleGeocoderServices`) stay in the offline lane on purpose — quarantining them would delete real offline coverage.

`gulp test --browsers=EdgeHeadlessCI` with `$env:CHROME_BIN` pointed at the Edge binary, and focused runs via `--includeName`, are unchanged.

---

## Upstream Cesium debug surfaces (inherited, available on every build)

`CesiumDebug` is a fork-added wrapper. Underneath, upstream Cesium has its own set of **first-class debug flags** on `Scene`, `Globe`, `Cesium3DTileset`, `Model`, and most primitives, plus standalone debug primitives and a debug imagery provider. These are part of the public API, work on both WebGL and WebGPU (with caveats noted), and are how you debug from the browser console even without `CesiumDebug` loaded.

**You probably don't need to write a probe for any of these — flip the flag from DevTools or Playwright and read the result.** They cover most "is the renderer doing what I think?" questions.

### Scene-level flags ([`Scene.js`](../packages/engine/Source/Scene/Scene.js))

| Property | Type | What it does | Backend |
| --- | --- | --- | --- |
| `scene.debugShowFramesPerSecond` | boolean | Renders an FPS counter in the top-left corner | both |
| `scene.debugShowCommands` | boolean | Colorizes draw commands by the primitive that issued them (debugging command-count regressions) | both |
| `scene.debugShowFrustums` | boolean | Colorizes frustum splits — red = far frustum, green = mid, blue = near | both |
| `scene.debugShowFrustumPlanes` | boolean | Draws the actual frustum-plane geometry as wire boxes in world space | both |
| `scene.debugShowDepthFrustum` | number (1..3) | Selects which frustum's depth the next `showDepth()`-style read targets. Default 1 = near | both |
| `scene.debugShowGlobeWireframe` | boolean | Globe terrain mesh wireframe (equivalent to `CesiumDebug.showWireframe()`) | both |
| `scene.debugShowCubeMapFace` | number (0..5) | Renders one face of the active cube map fullscreen (IBL diagnosis) | both |
| `scene.debugShowTerrainLOD` | boolean | Colorizes terrain tiles by LOD level (mutually exclusive with `debugShowTriangulation` and `debugShowTerrainNormals`) | both |
| `scene.debugShowTerrainNormals` | boolean | Renders terrain vertex normals as RGB | both |
| `scene.debugShowTriangulation` | boolean | Renders terrain triangulation (per-triangle solid color) | both |
| `scene.debugShowImageryLayer` | number (-1 to N) | Isolates one imagery layer (everything else hidden). -1 = all (default) | both |
| `scene.debugShowImageryProbe` | boolean | One-shot: next 4 tile updates dump to console. Same as `CesiumDebug.logImageryProbe()` | both |
| `scene.debugShowDepthAsColor` | boolean | Renders the depth buffer as grayscale fullscreen. WebGPU-routed via `WebGPUDebugDepthOverlay`; `CesiumDebug.showDepth()` calls this | WebGPU primary |
| `scene.debugCommandFilter` | `(command) => boolean` | Per-frame filter — return false to skip a command. Useful for "which exact command produces the artifact?" bisection | both |

**Example — bisect a command-count regression:**

```javascript
// In DevTools, narrow to just commands from one primitive type
scene.debugCommandFilter = (cmd) => cmd.owner?.constructor?.name === "GlobeSurfaceTile";
// Later
scene.debugCommandFilter = undefined; // restore
```

### Globe flags ([`Globe.js`](../packages/engine/Source/Scene/Globe.js))

| Property | What it does |
| --- | --- |
| `globe.showSkirts` | Toggle terrain tile skirts (the vertical edges between tiles that hide cracks). When false, exposed cracks are visible — useful for "is this a skirt issue or a real terrain problem?" |
| `globe.showWaterEffect` | Toggle the per-tile water-mask shading |
| `globe.showGroundAtmosphere` | Toggle ground atmosphere drape (turn off to isolate "is the atmosphere doing the damage?") |
| `globe.tileCacheSize` | LRU cache size for terrain tiles. Drop temporarily to force re-loads and check tile-load paths |
| `globe.tilesLoaded` (read-only) | Boolean — true when no terrain tiles are pending. The single most useful "is the scene settled?" check for Playwright |
| `globe.terrainProvider` | Read or swap the terrain provider live. Useful for "does this bug repro on WGS84 ellipsoid too?" |

### 3D Tiles flags ([`Cesium3DTileset.js`](../packages/engine/Source/Scene/Cesium3DTileset.js))

Every 3D Tileset exposes a rich debug-flag surface. All flags can be flipped at runtime — no recreate required.

| Property | What it does |
| --- | --- |
| `tileset.debugFreezeFrame` | Stop selecting new tiles; render only what was selected last frame. Lets you orbit the camera and see exactly which tiles were chosen at the frozen position |
| `tileset.debugColorizeTiles` | Assigns a random color to each tile — visualize tile boundaries and LOD selection |
| `tileset.debugWireframe` | Render each tile's content as wireframe. **Requires `enableDebugWireframe: true` at constructor time** for WebGL1 (no-op otherwise; WebGL2 + WebGPU work without the gate) |
| `tileset.debugShowBoundingVolume` | Bounding box per tile |
| `tileset.debugShowContentBoundingVolume` | Tighter bounding box of just the rendered content (differs from `debugShowBoundingVolume` when a tile's children fit inside a smaller envelope) |
| `tileset.debugShowViewerRequestVolume` | The "load this when camera enters" volume for streaming tilesets |
| `tileset.debugShowGeometricError` | Renders per-tile geometric-error labels in 3D — diagnose LOD-selection bugs |
| `tileset.debugShowRenderingStatistics` | Renders per-tile labels: command count, point count, triangle count, feature count |
| `tileset.debugShowMemoryUsage` | Renders per-tile texture + geometry memory labels (MB) |
| `tileset.debugShowUrl` | Renders the request URL on each tile — useful for "which CDN tile is broken?" |

**Example — diagnose a missing-tile bug:**

```javascript
const tileset = viewer.scene.primitives.get(0);
tileset.debugShowBoundingVolume = true;        // is the tile even being requested?
tileset.debugShowGeometricError = true;        // is the LOD selection wrong?
tileset.debugFreezeFrame = true;               // freeze, then orbit to inspect
tileset.debugShowUrl = true;                   // is the failing URL the one I think?
```

### Model flags ([`Model.js`](../packages/engine/Source/Scene/Model/Model.js))

| Property | What it does |
| --- | --- |
| `model.debugShowBoundingVolume` | Bounding sphere around the model |
| `model.debugWireframe` | Render model as wireframe. **Requires `enableDebugWireframe: true` in `Model.fromGltf`** (CesiumJS warns if you set debugWireframe without it) |

### Primitive / Collection flags

Every `Primitive`, `GroundPrimitive`, `BillboardCollection`, `BufferPrimitiveCollection`, `PolylineCollection` etc. exposes:

| Property | What it does |
| --- | --- |
| `*.debugShowBoundingVolume` | Bounding sphere around the primitive's draw command(s) |
| `groundPrimitive.debugShowShadowVolume` | The shadow volume used for classification primitives (the "wall" extruded above/below the terrain that intersects with the surface to draw the classification) |
| `billboardCollection.debugShowTextureAtlas` | Renders the texture atlas fullscreen — useful for "is my icon getting packed correctly?" |

### Standalone debug primitives (add to `scene.primitives`)

Pure-JS visualizers you add to the scene like any other primitive. Useful when none of the boolean flags fit your bisection.

| Class | Purpose |
| --- | --- |
| [`DebugCameraPrimitive`](../packages/engine/Source/Scene/DebugCameraPrimitive.js) | Visualize a camera's frustum as a wire-outlined box in 3D. Pass another camera (e.g., a shadow-cast camera, a saved view) to see exactly what it sees |
| [`DebugModelMatrixPrimitive`](../packages/engine/Source/Scene/DebugModelMatrixPrimitive.js) | Visualize a 4x4 transform as a 3-axis cross (red=X, green=Y, blue=Z). Useful for "is my entity at the right position/orientation?" |
| [`DebugAppearance`](../packages/engine/Source/Scene/DebugAppearance.js) | Visualize a vertex attribute as fragment color. Constructor takes the attribute name + GLSL datatype, then attach to a Primitive in place of its real Appearance |

**Example — visualize a shadow-cast camera:**

```javascript
import * as Cesium from "/Build/CesiumUnminified/index.js";
const lightCam = scene.shadowMap._shadowMapCamera; // example — pick your camera
const debugCam = new Cesium.DebugCameraPrimitive({
  camera: lightCam,
  color: Cesium.Color.YELLOW,
});
scene.primitives.add(debugCam);
// Now orbit your main camera and see exactly where the light is looking.
```

### Debug imagery providers

Two options, in increasing detail:

**[`TileCoordinatesImageryProvider`](../packages/engine/Source/Scene/TileCoordinatesImageryProvider.js)** — upstream Cesium, draws L/X/Y inside a colored box on every tile. Minimal but works on both backends.

```javascript
import * as Cesium from "/Build/CesiumUnminified/index.js";
viewer.imageryLayers.addImageryProvider(new Cesium.TileCoordinatesImageryProvider());
```

**[`DebugTileImageryProvider`](../packages/engine/Source/Scene/DebugTileImageryProvider.js)** — fork-specific. Same L/X/Y header plus per-tile rectangle (lat/lon corners in degrees), projection class, and a red border on tiles that straddle the Web Mercator ±85.0511° limit (the polar reprojection tiles per [`IMAGERY_PROJECTION.md`](IMAGERY_PROJECTION.md) Path B). Use this when investigating imagery sampling / tile selection / LOD / polar-reprojection bugs.

```javascript
// In DevTools console
CesiumDebug.tileDebugOverlay();                     // install with defaults
CesiumDebug.tileDebugOverlay({ colorByLevel: true }); // tint border by LOD
CesiumDebug.tileDebugOverlay(null);                  // remove
```

Use either to verify:

- Tile selection (which tiles are actually loaded at this LOD)
- Tile rectangle math (does the box align with the geographic / mercator rectangle?)
- LOD transitions (which level is being served at this camera distance?)
- **Polar-reprojection tiles** (DebugTileImageryProvider only — straddling tiles get a red border so you can see which ones go through Path B)

Pair with `globe.tileCacheSize = 0` to force fresh loads on every camera movement.

### Inspector widgets ([`packages/widgets/`](../packages/widgets/Source/))

For interactive debugging from a UI (not from console), three first-class Cesium widgets:

| Widget | Covers |
| --- | --- |
| [`CesiumInspector`](../packages/widgets/Source/CesiumInspector/CesiumInspector.js) | Globe wireframe, depth buffer, frustum splits, tile coordinates, primitive bounding-volume toggle. The "Cesium Sandcastle Cesium Inspector Demo" is the canonical reference |
| [`Cesium3DTilesInspector`](../packages/widgets/Source/Cesium3DTilesInspector/Cesium3DTilesInspector.js) | All `tileset.debug*` flags from above, plus style editor, max screen-space error slider, and tile cache stats |
| [`VoxelInspector`](../packages/widgets/Source/VoxelInspector/VoxelInspector.js) | Voxel primitive debug controls — shape, bounds, traversal stats |

Activate by adding `<div id="inspector-container"></div>` to your page and instantiating: `new Cesium.CesiumInspector("inspector-container", viewer.scene)`.

These wrap the same flags listed above but give you knobs/sliders instead of console commands. Useful when bisecting "is the bug a specific tile or an LOD transition?" interactively.

### Scene lifecycle events ([`Scene.js:2013+`](../packages/engine/Source/Scene/Scene.js))

Four events fire every frame in this order: `preUpdate` → `postUpdate` → `preRender` → `postRender`. Subscribe to inject debugging side effects without modifying renderer code:

```javascript
const remove = scene.postRender.addEventListener(() => {
  console.log({
    frame: scene.frameNumber,
    tiles: scene._globe?._surface?._tilesToRender?.length,
    commandCount: scene.frameState.commandList.length,
  });
});
// Later, remove the listener
remove();
```

Useful for "what does state X look like just before / after every render?" without touching the renderer source.

### Performance & FPS services ([`packages/engine/Source/Services/`](../packages/engine/Source/Services/))

| Service | Purpose |
| --- | --- |
| [`FpsOverlay`](../packages/engine/Source/Services/FpsOverlay.js) | Standalone FPS HUD (independent of `debugShowFramesPerSecond`). Works against a `PerformanceTracker`-shaped data source — local Scene OR a `WorkerSceneHost` posting back from a renderer worker |
| [`PerformanceTracker`](../packages/engine/Source/Services/PerformanceTracker.js) | Backend-neutral perf-trace recorder. `tracker.beginTrace(label, { frames: 600 })` → render 600 frames → `tracker.endTrace()` → `tracker.toCSV(result)`. Composes with `WebGPUTimestampProfiler` for GPU time |
| [`VisualPerformanceTargetService`](../packages/engine/Source/Services/VisualPerformanceTargetService.js) | Auto-adjusts visual quality to hit a frame-time target. Disable when chasing a perf regression so the target service isn't masking it |

### Snapshot service

`scene.getDebugSnapshot()` returns a structured object of every renderer toggle, render stats, post-process state, and (on WebGPU) device state. `scene.logDebugSnapshot()` pretty-prints it. The single best one-liner when you need to dump everything to attach to a bug report.

---

## WGSL / TS debug instrumentation (pragma-stripped from production)

CesiumJS has a pragma stripping system that removes debug-only code from production builds with **zero runtime cost**. Detail in [CLAUDE.md "Logging & Debug Pragmas"](../CLAUDE.md). Quick reference here:

### Wrap with pragmas when

- Per-frame or per-tile diagnostic logs (center3D, UV uniforms, pass counts).
- Init-time informational messages (feature detection, resource creation OK).
- Anything with string interpolation, `.toFixed()`, object stringification — work that has runtime cost even when the user doesn't open DevTools.

```typescript
//>>includeStart('debug', pragmas.debug);
console.log(`[WebGPU:GlobeTile] center3D: (${center.x.toFixed(1)}, ...)`);
//>>includeEnd('debug');
```

### Keep permanent (no pragma)

- `console.error` indicating a real bug producing broken output (null blit target, index overflow, command buffer invalidation, device lost).
- Shader compile errors / pipeline creation failures.
- Recovery / retry exhaustion.
- Infinite-loop sentinels and clear-loop detectors.

Real errors must always reach the console — that's how production bugs get reported.

### Pragma-aware predicates

When a diagnostic fires from many sites, wrap the throttle in a predicate whose body is pragma-stripped. The method returns `false` in production and the call sites become dead code that esbuild removes:

```typescript
private _diagShouldLog(): boolean {
  //>>includeStart('debug', pragmas.debug);
  if (this._diagTileCount !== 0) return false;
  const now = performance.now();
  if (now - this._diagLastLogTime < 3000) return false;
  this._diagLastLogTime = now;
  return true;
  //>>includeEnd('debug');
  return false;
}
```

### Permanent sentinels every new subsystem SHOULD add

1. **Re-entry / infinite-loop guard** — counter in the per-frame entry, throttled `console.error` past a sane limit.
2. **Null target guard** — check source/destination texture views at render-pass boundaries.
3. **Size validation** — check buffer sizes vs index/vertex counts before submitting draws.

These catch the failure modes of BUG-12 (clear loop), BUG-13 (null PP views), BUG-15 (index overflow) without needing deep debugging.

### Adding a WGSL debug branch

The globe FS uses the `globeFragmentDebug` registry (above). For other shaders, the established pattern is a sentinel-driven branch gated on a uniform that's only set when a JS-side debug flag is on. The JS write should be inside `//>>includeStart('debug', pragmas.debug)` so the writer is stripped — the branch itself stays in the shader but is dead code in production (cost: one comparison per pixel).

When adding a debug branch:

- Use a single registry module (see [WebGPUGlobeFragmentDebug.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts) as a template) so adding a mode is one entry, not 16 separate flags scattered across files.
- Expose via `CesiumDebug` so users can use it without recompiling.
- Document in this guide.

---

## Using debug surfaces from Playwright

Every debug surface in this guide — both fork-added (`CesiumDebug`, `globeFragmentDebug`) and upstream (`scene.debug*`, `tileset.debug*`, `DebugCameraPrimitive`, `TileCoordinatesImageryProvider`) — is reachable from automated probes via Playwright's `page.evaluate()`. The pattern is the same for every probe; copy it instead of re-inventing.

### Serving an attestable bundle (`--serve-built`)

Certification and acceptance runs must attest the **gulp artifact**, not the dev server's
in-memory build (`R-2026-08-24-2`, completing `R-2026-08-21-5`). Iteration and debugging runs may
use the default development build.

```powershell
node server.js --serve-built --no-embeddings
```

**What it serves.** `Build/CesiumUnminified` straight off disk — the exact tree `npx gulp build`
produced. The default mode instead serves `Build/CesiumDev` plus a separate incremental in-memory
build, so hashing the disk bundle and fetching the same URL compares two different esbuild
outputs.

**Why this mode and not `--production`.** `--serve-built` **fail-closes**: it throws before
binding a port if `Build/CesiumUnminified` or its `Cesium.js` is missing, telling you to run
`npx gulp build` first (`server.js:37-49`). `--production` (`server.js:58-64`) performs no
existence check, so a stale or absent bundle degrades into mid-run 404s that read as probe
failures. `CESIUM_SERVE_BUILT=1` is equivalent to the flag.

**`--no-embeddings` is inert in this mode** — harmless, and worth knowing so nobody hunts for its
effect. The Sandcastle embeddings build is gated behind
`artifactConfiguration.generateDevelopmentBuild` (`server.js:215`), which `--serve-built` sets
false, so the flag only bites in the default dev mode.

**The provenance gate.** Serving the right directory is an operator claim, not evidence. A
certifying probe must additionally assert that the bytes it fetched hash-match the artifact on
disk. Use the shared helper rather than re-rolling one: `validateServedEntryIdentities` from
[`lib/build-source-identity.mjs`](../Tools/visual-regression/lib/build-source-identity.mjs) — it
compares `sha256` + byte length per session label and fails closed with _"served runtime entry
differs from the local start entry"_. Worked examples: `probe-eclipse-cloud-response.mjs` (shared
helper) and `probe-cloud-u2-perf.mjs` (bespoke, throws). Without this assertion a green run proves
the probe rendered _something_, not that it rendered the bundle under certification.

**Refresh sequence.** The bundle is not rebuilt by the server in this mode, so refresh it yourself
before a run whose evidence must bind to current source:

```powershell
npx gulp buildCesiumDual
npx gulp build
```

`buildCesiumDual` produces the dual-backend `Build/Cesium{Unminified}`; `gulp build` refreshes the
workspace bundles the server and specs resolve against. Restart the server after either — it reads
the directory once at startup.

**Provenance caveat.** `gulp buildCesiumDual` builds from the **working tree**, not from `HEAD`. If
the tree is dirty, every run record must declare provenance as "tip `<sha>` + `<named dirty set>`";
a dirty-tree run may never claim source identity = tip.

**Host.** The dev server binds the hostname `localhost`, which resolves to `::1` first on this
machine — use `http://localhost:8080`, **never** `http://127.0.0.1:8080`.

### Boilerplate (matches `probe-saved-view.mjs`)

```javascript
import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "msedge",            // Edge has WebGPU enabled out of the box
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan",
    "--disable-cache",          // important — old shader bytes can mask fixes
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Capture console + page errors for the report
const messages = [];
page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

await page.goto(`http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);
```

### Flipping a debug flag

```javascript
await page.evaluate(() => {
  const v = window.viewer;
  v.scene.debugShowFrustums = true;
  v.scene.debugShowGlobeWireframe = true;
});
```

### Importing Cesium inside the page for class-level debug primitives

The CesiumViewer page exposes `window.viewer` but doesn't keep a `Cesium` namespace handy. Import from the dev-server build inside `page.evaluate`:

```javascript
await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;

  // Add a TileCoordinates overlay
  v.imageryLayers.addImageryProvider(new C.TileCoordinatesImageryProvider());

  // Visualize the shadow-cast camera
  const debugCam = new C.DebugCameraPrimitive({
    camera: v.scene.shadowMap._shadowMapCamera,
    color: C.Color.YELLOW,
  });
  v.scene.primitives.add(debugCam);
});
```

### Waiting for the scene to settle

The single most useful flag for "wait until everything is loaded" is `globe.tilesLoaded`. Combine with a hard frame cap so a stuck network doesn't hang the probe:

```javascript
await page.evaluate(async () => {
  const v = window.viewer;
  for (let i = 0; i < 1200; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (v.scene.globe.tilesLoaded && i > 60) break;   // settled
  }
});
await page.waitForTimeout(1500);  // belt-and-braces for async texture uploads
```

Many existing probes use a hard `for (let i = 0; i < 1200; i++)` loop without the `tilesLoaded` check. That works, just wastes wall-clock; **prefer the `tilesLoaded` short-circuit for new probes**.

### Subscribing to lifecycle events from Playwright

```javascript
const frameStats = await page.evaluate(async () => {
  const v = window.viewer;
  const samples = [];
  const remove = v.scene.postRender.addEventListener(() => {
    samples.push({
      frame: v.scene.frameNumber,
      tiles: v.scene._globe?._surface?._tilesToRender?.length,
      commandCount: v.scene.frameState.commandList.length,
    });
  });
  for (let i = 0; i < 120; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  remove();
  return samples;
});
console.log(`Captured ${frameStats.length} frame samples`);
```

### Reading `getDebugSnapshot()`

Snapshot fields worth knowing: `snap.attachmentDemand` (C9-09 scene-FB topology) and
`snap.frustums.count` (**C10-01** — number of depth frustums the last frame split into; the default
3D scene is `1` on both backends, matching WebGL, since BV-less `Pass.ENVIRONMENT` commands no
longer widen near/far. A value of `2` on a default 3D frame means a BV-less near/far widener has
regressed — see `probe-frustum-count-3d.mjs`). `scene.numberOfFrustums` is the live getter for the
same value.

```javascript
const snapshot = await page.evaluate(() => window.viewer.scene.getDebugSnapshot());
require("fs").writeFileSync(
  "Tools/visual-regression/output/debug-snapshot.json",
  JSON.stringify(snapshot, null, 2),
);
```

### Using `CesiumDebug.globeFragmentDebug()`

```javascript
await page.evaluate(() => window.CesiumDebug.globeFragmentDebug("post-composite-color"));
await page.evaluate(async () => {
  for (let i = 0; i < 600; i++) {
    window.viewer.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
});
await page.screenshot({ path: "Tools/visual-regression/output/post-composite.png" });
await page.evaluate(() => window.CesiumDebug.globeFragmentDebug(null));   // restore
```

[`probe-debug-api.mjs`](../Tools/visual-regression/probe-debug-api.mjs) is the end-to-end test for this exact flow — copy from there.

### Capturing perf traces

```javascript
const trace = await page.evaluate(async () => {
  const v = window.viewer;
  v.scene.requestRenderMode = false;
  v.scene.beginPerformanceTrace("orbit-snapshot", { frames: 600 });
  while (v.scene.performanceTracker.active) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  const result = v.scene.endPerformanceTrace();
  return {
    csv: v.scene.performanceTracker.toCSV(result),
    summary: result.summary,
  };
});
require("fs").writeFileSync(
  "Tools/visual-regression/output/perf-trace.csv",
  trace.csv,
);
```

For GPU timings specifically, call `CesiumDebug.gpuPassCost(true)` before the trace, then `CesiumDebug.gpuPassCost()` to return a structured object. When `timestamp-query` is available it reports the first-to-last timed-pass span, named-pass sum, explicit unprofiled remainder, and coverage ratio. Call `CesiumDebug.gpuPassCost(false)` when finished.

For comparable campaign output, prefer the versioned Node runner over ad hoc loops:

```powershell
node Tools/visual-regression/run-performance-campaign.mjs --workload settled-static-3d --repetitions 1 --frames 120
node Tools/visual-regression/probe-webgpu-allocation-tax.mjs --output Tools/visual-regression/output/allocation-tax.json
```

Both launch Edge from Node. Do not substitute a Python HTTP server or Python browser driver.

### Canvas readback caveat

`canvas.getContext('2d').getImageData(...)` returns **all-zeros** in headless mode because the canvas has `preserveDrawingBuffer: false` by default. Two workarounds:

1. **Read the screenshot PNG**, not the canvas. `page.screenshot({ path: ... })` captures the composited frame correctly.
2. **Decode the PNG in the page context** by drawing it into a temp canvas — see `probe-saved-view.mjs` for the canvas-decode diff helper.

Do NOT trust in-page `getImageData` brightness/diff numbers — those will report all-zeros and falsely declare parity.

### Sequencing flag toggles with rendering

A flag set via `page.evaluate` takes effect on the **next** `scene.render()`. If you set a flag and immediately screenshot, the new flag hasn't been picked up yet:

```javascript
// WRONG — screenshot captures the pre-flip state
await page.evaluate(() => { window.viewer.scene.debugShowFrustums = true; });
await page.screenshot({ path: "out.png" });   // still shows old state

// RIGHT — flip flag, render forward, then screenshot
await page.evaluate(async () => {
  window.viewer.scene.debugShowFrustums = true;
  for (let i = 0; i < 30; i++) {
    window.viewer.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
});
await page.screenshot({ path: "out.png" });
```

30 frames is usually enough; bump to 300 for streaming-tile scenarios where the flag-change triggers re-loads.

### Restoring state between probe scenarios

When a single probe script tests multiple debug modes in sequence, always restore between scenarios so a later scenario doesn't inherit a stale flag:

```javascript
async function captureWithMode(mode) {
  await page.evaluate((m) => window.CesiumDebug.globeFragmentDebug(m), mode);
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.screenshot({ path: `out-${mode}.png` });
  await page.evaluate(() => window.CesiumDebug.globeFragmentDebug(null));   // restore!
}
```

Same applies to `debugShowFrustums`, `debugFreezeFrame`, `debugColorizeTiles`, `debugCommandFilter`, etc.

### Common gotchas

- **`globe.terrainProvider` swap requires settle time** — switching terrain providers invalidates the tile cache. After `vm.selectedTerrain = newTvm`, render for at least 600 frames OR wait on `globe.tilesLoaded`.
- **`tileset.debugFreezeFrame = true` BEFORE `tileset.debugShowBoundingVolume = true`** — otherwise the bounding volumes flicker as new tiles get selected. Freeze first, then visualize.
- **WebGPU `--use-vulkan` doesn't work on every Windows GPU** — drop it if Edge falls back to software rendering. `--enable-unsafe-webgpu --enable-features=Vulkan` is the safer default for Edge on Windows.
- **Always quote URL query params with spaces** — saved-view URLs have commas in them; Playwright handles this fine but URL-encoding errors will show as a blank canvas.
- **`window.CesiumDebug` may not exist immediately after `goto`** — it's installed by CesiumViewer's init code. Use `await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 })` before calling it.

---

## Pipeline bugs

WebGPU adds a class of failures WebGL didn't have: shader compilation succeeds but pipeline creation fails (binding mismatch, bind-group-layout mismatch, vertex-buffer stride mismatch). Symptoms: console error like "validation error: GPURenderPipeline …" or a tile draw that silently produces no fragments.

### First line

- `CesiumDebug.pipelineStatus()` — device-loss state, FB attachment, render-pass open/closed, frame count.
- Console error message — WebGPU validation errors are precise; the message usually names the binding / location.

### Bind-group / layout mismatch

- The bind-group-layout is the source of truth; the bind-group must match. If a shader uses a binding that isn't in the layout, the pipeline rejects at creation time.
- For an example of the diagnostic flow, see Batch 14 in [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) — "Pipeline creation failed: bind group layout mismatch at index 2".

### Shader compilation

- `device.createShaderModule()` returns a module even on parse failure — the error surfaces at pipeline creation. WGSL parse messages name the line, the unexpected token, and the rule. Read them — they're better than GLSL's.
- For the cached path, the module is keyed by `(sourceId, defines)` — see [WebGPUShaderModuleCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderModuleCache.ts) and [CLAUDE.md "WGSL Shader Pipeline"](../CLAUDE.md).

### Vertex-buffer stride / format

- The vertex-buffer layout in the pipeline must match the buffer the renderer actually binds. Wrong stride = garbage vertices = a globe rendering as a single point or a fan. Often visible as "globe is invisible but no error" because validation only catches stride mismatches, not semantic ones.
- `probe-vec4-error.mjs` reproduces the most common variant.

---

## TypeScript bugs

### Co-located `.d.ts` for JS interop

When a TS file needs to call into an untyped JS class, write a sibling `ClassName.d.ts` next to `ClassName.js`. TypeScript's `allowJs: true, checkJs: false` means the `.d.ts` **overrides** JS inference — no tsconfig changes needed. Templates: [`Context.d.ts`](../packages/engine/Source/Renderer/Context.d.ts), [`Texture.d.ts`](../packages/engine/Source/Renderer/Texture.d.ts), [`Matrix4.d.ts`](../packages/engine/Source/Core/Matrix4.d.ts).

For classes matching an existing ambient interface, use declaration merging:

```typescript
declare class X {}
interface X extends AmbientShape {}
```

### `@private` JSDoc ≠ TS `private`

CesiumJS uses `@private` to mean "not in the published API" but TypeScript correctly interprets it as class-scoped visibility. If a JS method is called cross-module:

- **Tactical:** declare it `public` in a co-located `.d.ts`.
- **Strategic:** change the JSDoc tag to `@internal` — zero runtime change, preserves doc-strip intent, avoids the TS visibility trap.

### Don't trim WIP-module interfaces during cast cleanup

Some `CesiumGraphicsContext`-adjacent interfaces (e.g., `PerformanceManagerContext`) carry forward-looking method slots that aren't yet implemented on the real classes. The cast at the construction site bridges the gap intentionally. Don't delete interface methods because grep shows no callers — verify the owning module is fully implemented first. [CLAUDE.md "Preferred Tech Stack"](../CLAUDE.md) has the full rule.

---

## Perf bugs

### Canonical moving-altitude campaign (2026-07-14)

Do not use an idle soak to compare FPS. Cesium request-render mode legitimately pauses rendering when
the scene has no active change, so an unchanged globe measures the scheduler's ability to sleep rather
than renderer throughput. Use the versioned camera flight, which continuously traverses nine waypoints
from 18,000 km orbit to 300 m above ground and back to a 2,500 km rotating view. The report must show
all eight route segments and the full altitude range as covered.

Start the repository's Node server in one terminal:

```powershell
node server.js --production
```

Run the clean, counterbalanced WebGL/WebGPU lane from another terminal:

```powershell
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-altitude-track-3d `
  --renderer both `
  --repetitions 2 `
  --output Tools/visual-regression/output/performance/altitude-track-clean.json
```

Run API-boundary attribution separately:

```powershell
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-altitude-track-3d `
  --renderer both `
  --repetitions 2 `
  --api-instrumentation `
  --output Tools/visual-regression/output/performance/altitude-track-instrumented.json
```

Never combine timing samples from those lanes: API monkey-patching adds observer overhead. Treat full
`Scene.render()` CPU distributions and capability-backed GPU timestamps as the primary promotion
metrics. FPS, 1%-low, dropped-frame, and wall-time results describe the display-paced experience but
can remain refresh/compositor limited even when CPU and GPU work improve. Alternate WebGL→WebGPU and
WebGPU→WebGL repetitions to counterbalance thermal and launch-order drift. The exact 2026-07-14
protocol, bundle hashes, and results are in
[Fork Performance Audit and Fix Results](FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md).

`NEW-PERF-CAPPED-UNCAPPED-LANES` remains future work. Keep the current capped flight as the
responsiveness/1%-low lane, and add a separate Node/Edge maximum-throughput lane only after it verifies
supported no-vsync/no-frame-limit launch flags. A page checkbox can select engine pacing, but JavaScript
cannot promise control of the OS/compositor swap interval; artifacts must record both UI pacing and
browser launch mode. In an uncapped lane, report CPU renders/second and GPU timestamp throughput before
presented FPS.

### Campaign 13 cloud probes (C13-01 Slice A)

Campaign 13 begins with deterministic, offline Node/Playwright characterization rather than a renderer
change. Start `node server.js --production`; all commands below use the local viewer with `offline=true`,
disable request-render pausing and clock animation, and render authored fixed times. The injected
[`cloud-probe-harness.mjs`](../Tools/visual-regression/lib/cloud-probe-harness.mjs) configures
`globe.defaultCloudCollection.volumetric` directly. It rejects unknown/misspelled properties, requires
WebGPU where requested, and verifies that `requestRenderMode`, `enableVolumetric`, and every requested
value round-trip exactly. Procedural probes also await the exported lazy feature renderer and drive
bounded camera motion until a real execute initializes the cache; a fixed warm-up count is not
readiness because an empty/idle command list can skip the environment chain. Treat the emitted truth
JSON as part of the evidence; a screenshot without matching configuration and realization truth is
invalid.

Use the full static tour for cloud types, lighting, altitude, dateline, poles, and billboard parity:

```powershell
node Tools/visual-regression/probe-cloud-tour.mjs
```

For the short seam/pole/API smoke:

```powershell
$env:TOUR_SCENES = "proc-dateline-east-horizon,proc-dateline-west-horizon,proc-north-pole-oblique,proc-south-pole-oblique,billboard-cumulus-noon"
node Tools/visual-regression/probe-cloud-tour.mjs
Remove-Item Env:TOUR_SCENES
```

Procedural volumetrics run only on WebGPU. Billboard `CloudCollection` scenes run on both renderers so
the shared API/WebGL path remains covered. Outputs are
`Tools/visual-regression/output/cloud-tour/<scene>-<backend>.png` plus
`cloud-tour-truth.json`; configuration mismatches, new
console/page/GPU/device errors, and missing cloud-contribution evidence in a
gated seam/pole/billboard fixture fail the probe. Procedural fixtures use a
same-camera, same-time OFF/ON delta so polar or dusk cloud color cannot fool a
bright-neutral-pixel heuristic; billboard parity retains its neutral-pixel
metric. Do not lower the gate to make a known defect green.

Use the dynamic WGS84/RTE oracle for route-ordered antimeridian, pole, and altitude coverage:

```powershell
node Tools/visual-regression/probe-cloud-planetary.mjs
```

For a focused pole and explicit precision A/B:

```powershell
$env:CLOUD_PLANETARY_ROUTES = "north-pole"
$env:CLOUD_RTE_MODE = "on"
node Tools/visual-regression/probe-cloud-planetary.mjs
$env:CLOUD_RTE_MODE = "off"
node Tools/visual-regression/probe-cloud-planetary.mjs
Remove-Item Env:CLOUD_PLANETARY_ROUTES
Remove-Item Env:CLOUD_RTE_MODE
```

Routes are `antimeridian`, `north-pole`, `south-pole`, and `altitude`; precision modes are `default`,
`on`, and `off`. Consecutive checkpoints are joined by deterministic camera-motion frames before
each settled checkpoint renders clouds OFF and ON at the same camera/authored time and measures the
raw-canvas delta. This avoids certifying blue sky, terrain, UI, or an idle renderer as clouds. Mode
and selected route set are encoded in every filename, so A/B and subset runs do not overwrite one
another. PNG pairs plus `cloud-planetary-<mode>-<route-set>-truth.json` are written under
`Tools/visual-regression/output/cloud-planetary/`; each truth file records the
source commit/dirty state and runtime-bundle length/SHA-256 to expose stale
builds. The governing rules are in the
[Campaign 13 Cloud Coordinate Contract](CLOUD_COORDINATE_CONTRACT_2026-07-23.md).

Use the fixed-time temporal sequence to inspect static convergence, mid-pan ghosting, and post-pan
settling:

```powershell
$env:TEMPORAL_TIER = "medium"
node Tools/visual-regression/probe-cloud-temporal.mjs
Remove-Item Env:TEMPORAL_TIER
```

`TEMPORAL_TIER` is `low` or `medium`. Outputs land under
`Tools/visual-regression/output/cloud-temporal/` as the three phase PNGs and
`<tier>-truth.json`; the truth record includes effective time, resolved configuration, and errors.

Use the fixture/sequence tour for the C13-01 evidence tail — climate/region/type/same-type fixtures,
wind/time and temporal-reset sequences, complete per-sequence metrics, and GPU timing:

```powershell
node --test Tools/visual-regression/cloud-tour-sequences.spec.mjs
node Tools/visual-regression/probe-cloud-tour-sequences.mjs
```

The definitions are pure data in
[`lib/cloud-tour-fixtures.mjs`](../Tools/visual-regression/lib/cloud-tour-fixtures.mjs) and the
metrics are pure functions in
[`lib/cloud-tour-metrics.mjs`](../Tools/visual-regression/lib/cloud-tour-metrics.mjs), so
**run the spec first** — it validates coverage, determinism, and probe discipline in milliseconds and
the probe refuses to launch a browser on a table that does not validate. The spec also pins the
mirrored engine constants (temporal reset bits, cloud quality-flag bits, the tier preset table, the
genus enum) against the engine's own exports, so a renumbered engine constant fails in Node rather
than producing a manifest that names the wrong cause.

Two lanes, selected with `TOUR_LANES` (default both):

- `fixtures` — twelve climate/region fixtures spanning six WMO genera with same-type formation pairs,
  a near-clear negative control, both antimeridian directions as a configuration-identical twin pair,
  both poles (the Antarctic fixture is pinned to the DECEMBER solstice — a June-locked southern
  fixture measures polar night), and ground/inside-deck/above-deck/orbital stations visited in order
  with interpolated transitions. Each station renders OFF then ON at the same camera and instant; the
  delta is the contribution. Each fixture declares its OWN gate and the reason for it — the cirrus
  floor is two orders of magnitude below the nimbostratus floor because judging both by one threshold
  rejects a correct wispy render.
- `sequences` — three wind/time lanes one variable apart (pinned/no wind, advancing/no wind,
  advancing/wind: cloud time comes from `frameState.time`, so a pinned clock freezes the field no
  matter what `cloudWindSpeed` says, and advection is only separable from sun motion as the difference
  between lanes), a camera teleport, a four-cause history-reset taxonomy, and a pan-and-return ghost
  oracle. Each sequence gets its own page because they assert history-reset semantics. Phases declare
  `expectResetBits`/`forbidResetBits` against the `WebGPUCloudTemporalHistory.ts` bit table, and the
  assertion is two-sided: `expectResetBits: 0` means a settled phase must NOT reset.

Env: `TOUR_LANES`, `TOUR_FIXTURES`, `TOUR_SEQUENCE_IDS`, `TOUR_CAPTURE_STRIDE`, `TOUR_WIDTH`/`TOUR_HEIGHT`,
and the A/B bookkeeping `TOUR_PAIR_ID` / `TOUR_TAG` / `TOUR_ROUND` / `TOUR_ORDER`. Artifacts land under
`Tools/visual-regression/output/cloud-tour-sequences/` as per-station and per-phase PNGs plus a manifest
recording, per sequence, the source commit and runtime-bundle SHA-256, adapter, canvas resolution,
derived tier with its evidence, current/history target dimensions, the CPU frame distribution
(p50/p95/p99, with capture frames excluded and the exclusion counted), the available GPU timestamps per
declared pass, the temporal delta/ghost metrics, and the screenshots with their hashes.
`validateSequenceMetricRecord` fails the run if any of those is missing, so a thinned manifest is RED
rather than a quiet gap.

**GPU timing is characterization until it is interleaved.** A single run measures; it does not compare.
For an A/B, build both bundles once, keep them side by side, and alternate `TOUR_TAG=pre` / `post`
within one session with `TOUR_ROUND` incrementing and at least one round declared `TOUR_ORDER=post-first`.
Feed every manifest for the pair to `assessInterleavedAb` — it refuses a same-SHA pair, a single round,
a single ordering, differing replay keys, and a round whose declared control pass moved outside the
drift band, which is the exact 2026-07-24 signature that produced impossible bidirectional deltas on
shaders the change never touched. The per-sequence GPU figure covers the profiler's rolling window, so
the manifest records `measuredFrames` vs `windowFrames` and never claims per-phase attribution.

Use the Campaign-13 ray-phase contracts and banding characterization for `C13-36`:

```powershell
node --test Tools/visual-regression/cloud-ray-jitter.spec.mjs
node Tools/visual-regression/probe-cloud-banding.mjs
$env:CLOUD_BANDING_QUALITY = "high"
node Tools/visual-regression/probe-cloud-banding.mjs
Remove-Item Env:CLOUD_BANDING_QUALITY
```

The source suite models WGSL arithmetic as f32, covers near/horizon/orbit march intervals, and runs
the complete cloud shader through Naga. The browser probe defaults to `TAG=after`, low temporal
quality, fixed time/camera, zero wind, and offline WebGPU. `CLOUD_BANDING_QUALITY=high` exercises the
full-resolution temporal-off tier and requires the single/frame-32 captures to be pixel-identical.
Artifacts land under `Tools/visual-regression/output/cloud-banding/` with quality and tag in every
filename.

For a real before/after banding claim, run separately built source states with the same nonempty
`CLOUD_BANDING_PAIR_ID`, `TAG=before`/`after`, browser, adapter, resolution, and configuration. The
probe rejects identical build fingerprints and missing/stale companions. An unpaired run is valid
characterization only. Its provisional coherent-contour metric must be reviewed with the PNGs and
does not certify baked-noise periodicity, temporal-history invalidation, god-ray mask alignment, or
performance.

Use the fixed-scene queue-drain probe for maximum-throughput characterization:

```powershell
$env:CLOUD_PERF_PAIR_ID = "w5-local-2026-07-23"
$env:TAG = "adaptive"
node Tools/visual-regression/probe-cloud-perf.mjs
Remove-Item Env:CLOUD_PERF_PAIR_ID
Remove-Item Env:TAG
```

It writes `Tools/visual-regression/output/cloud-perf-<tag>.{png,json}` and gates configuration truth,
an actual lazy-renderer execute, `maxSteps=128`, the full-resolution non-temporal target path,
WebGPU device/browser errors, and cloud-pixel liveness. `TAG` labels the current executable; it does not
switch implementations. An adaptive/fixed A/B is valid only after running two separately checked-out
implementations under their matching tags and the same explicit `CLOUD_PERF_PAIR_ID`. Source/runtime
bundle, adapter, browser, resolution, configuration, liveness, and error truth are recorded; unpaired,
same-bundle, stale, invalid, or differently configured companion artifacts are rejected. A single-tag
result cannot establish a speedup. With `CLOUD_PERF_PAIR_ID` set, the first capture writes its artifact
but intentionally exits RED until the comparable companion has been produced.

Use the dedicated zero-frustum scheduler acceptance when validating a
sky-only/black-sky cloud fix:

```powershell
node Tools/visual-regression/probe-cloud-empty-frustum.mjs
```

The managed and real user-owned volumetric phases each require zero command
frustums while resource setup, post-processing, environmental effects,
procedural clouds, and canvas writes all execute; the user-owned phase keeps
the managed collection off. The disabled control uses the same camera and
requires those stages to remain skipped, preserving the true-empty fast path.
Its truth JSON and three PNGs are written under
`Tools/visual-regression/output/cloud-empty-frustum/`.

Use the canonical moving route to characterize volumetrics across camera-distance bands:

```powershell
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-cloud-altitude-track-3d `
  --renderer webgpu `
  --repetitions 1 `
  --output Tools/visual-regression/output/performance/campaign13-cloud-route.json
```

The workload is WebGPU-only and records the exact cloud configuration in `featureState`: coverage `0.5`,
density `0.75`, layer `1500–3800 m`, medium temporal quality, `64` march steps, with weather-map
animation, wind, shadows/cascades, cloud IBL, multi-deck, and other optional paths disabled; the
production high-precision WGS84 path is enabled. It fails on
the wrong renderer, external requests, page/device errors, missing samples, or incomplete/misaligned
route coverage. It also requires realized raymarch, temporal-resolve, upscale, current-target, and
history-target evidence; API configuration alone cannot prove the pass ran. Its only valid cloud-off
reference is the same runner and renderer with
`moving-camera-altitude-track-3d`.
An explicit cloud workload request with `--renderer webgl` or `both` fails rather than silently
dropping WebGL. An implicit all-workload campaign retains the WebGPU run and records the per-workload
WebGL skip in its report.

**Evidence limit:** C13-01 Slice A is characterization, not a promotion/performance claim. The cloud-on
and cloud-off workloads are not yet scheduled as a cross-workload counterbalanced pair, so their raw
delta can include launch-order, thermal, and browser-state drift. Static dateline/pole scenes do not
prove dynamic seam crossings, RTE correctness, regional weather, or temporal-history validity.
[Campaign 13](QUEUE_2026-07-23_CAMPAIGN13.md) therefore keeps C13-01 incomplete while those fixtures and
gates remain open.

### CPU pass cost (R-7a)

`CesiumDebug.cpuPassCost(true)` enables the per-pass profiler in the WebGPU scene renderer. Pass `false` to disable, no-arg to dump rolling-window stats.

Use cases:

- Decide which passes are worth GPURenderBundle expansion (>5 ms avg = strong candidate; <1 ms = not worth it).
- Catch a regression where a previously-cheap pass starts dominating.

### GPU pass cost

`CesiumDebug.gpuPassCost(true)` enables and resets `WebGPUTimestampProfiler`; `gpuPassCost()` dumps its resolved samples and `gpuPassCost(false)` disables collection. Calling the no-argument form while profiling is off does not allocate query resources. The profiler needs the `timestamp-query` device feature (gated by `WebGPUFeatureFlags`). Unsupported adapters report capability failure and leave profiling disabled. `frameCount` is the number of resolved samples; `attemptedFrameCount`, `readbackSkipCount`, `droppedPassCount`, and `failedReadbackCount` make missing samples explicit. An active profiler with no rows means no instrumented pass has resolved yet, not a zero-cost frame. GPU coverage is still partial during FAR-001: direct feature-owned pass creation must migrate before `frameMs` can be interpreted as total GPU-frame time.

Unlike CPU pass cost, GPU timings show actual shader-execution cost — useful for identifying fillrate-bound passes (Bloom, AO) vs compute-bound ones.

**Unique-sample accounting (C11-140, 2026-08-07).** `gpuPassCost()` now prints a second line after the table, and the returned object carries the same fields:

- `coveredMs` is the **union** of the timed pass intervals — every GPU nanosecond inside the frame span counted once. `profiledPassMs` remains the naive per-pass sum, and `overlapMs = profiledPassMs − coveredMs` is non-zero exactly when timed passes overlapped in GPU time. `coverageRatio` is now `coveredMs / frameMs` (union-derived, so it cannot exceed 1) plus `unprofiledRatio`; the two sum to 1. The previous ratio divided the SUM by the span and clamped to 1, which reported 100% coverage for a frame that had double-counted.
- The sample ledger closes: `attemptedFrameCount == frameCount + readbackSkipCount + emptyFrameCount + failedReadbackCount + lostSampleCount + pendingReadbackCount`, asserted as `sampleLedgerBalanced` with `unaccountedSampleCount`. An unbalanced ledger prints a `console.error` — the timings under-report when a frame drops out of it.
- `profiler.drainPendingReadbacks(timeoutMs)` drains the readback tail at capture end so a capture's final frames are reported instead of dropped. It is bounded: a readback that will never complete (device loss) is reported as `undrained`, never waited on forever. `Tools/visual-regression/probe-gpu-timestamp-profiler.mjs` calls it and writes `gpu-timestamp-accounting-certification.json` — the artifact other perf items cite instead of re-deriving a timer's trustworthiness.

### High-density culling (Batch 217)

`CesiumDebug.highDensityCull()` dumps gpuCuller / HiZ / sort-keys effectiveness:

- `active`: hysteresis state. True when the dispatcher is engaged.
- `hitRatio`: fraction of input commands the GPU filter dropped. >0.2 = paying for itself; near 0 = CPU cull was already tight enough.
- `dispatches`: lifetime count since context init.

### Frame counts / dispatcher state

`CesiumDebug.snapshot()` includes frame count, pass counts, and dispatcher state. Useful baseline before / after a perf change.

---

## Streaming / tile-loading bugs

### Imagery probe

`CesiumDebug.logImageryProbe()` arms a one-shot: the next 4 tile updates dump to console with `readyImagery` / `loadingImagery` / texture handle state. Read those lines to see whether the bug is "tile never reaches READY", "parent imagery is being substituted", or "texture handle is set but the upload failed".

### Tile mesh state

`CesiumDebug.scene._globe._surface._tilesToRender` is the live tile array. Each tile has `data.mesh`, `data.imagery[]`, `data.imagery[i].readyImagery`. Inspect in DevTools — `useWebMercatorT`, `textureTranslationAndScale`, `textureCoordinateRectangle` are the projection-chain fields.

See **[IMAGERY_PROJECTION.md](IMAGERY_PROJECTION.md)** for the full projection-state model and what each field means.

### Async resource monitor

`probe-async-resource-monitor.mjs` traces resource-lifecycle events over many frames. Useful when imagery loads inconsistently or texture caches leak.

---

## Picking bugs

Picking can't be probed via screenshot — the picked feature is returned in JS, not rendered. Probes use `verify-model-feature-pick.mjs` / `verify-pick-webgl-control.mjs` as templates: they programmatically call `scene.pick(windowPos)` at known feature locations and assert the returned feature.

For metadata pick (3D Tiles), additional probes use `scene.pickMetadata()` and check the returned property values.

The pick framebuffer is its own render path. **There is currently NO instrument for it** — `CesiumDebug.snapshot()` does NOT report pick state (`Scene.getDebugSnapshot()` has no `pick` key), and `WebGPUPickFramebuffer` carries no counters at all. Building one is stage S0 of [`PICKING_ARCHITECTURE_STATE_2026-08-17.md`](PICKING_ARCHITECTURE_STATE_2026-08-17.md). Until it lands, an empty pick cannot be distinguished from a declined-cache or not-yet-ready pick from the console. Pick failures often show up as "scene.pick returns undefined" without any visible artifact — the failure is in the depth blit or the pick texture, not the main render. **[Landed Batch 1075 (`d4fa0ecf48`), 2026-08-20: stage S0 shipped — `WebGPUPickFramebuffer` now stamps readback regions with the pick clock and publishes served/cold/decline counters via `getStatistics()`, surfaced as `CesiumDebug.pick(reset?)`; S1 moved Viewer selection/tracking to `scene.pickAsync`. The "currently NO instrument" sentence describes the pre-S0 state. The ViewerSelectionAsyncSpec Karma leg ran tonight in the machine lane: 15/15; the browser acceptance rerun stays owed.]**

---

## Sandcastle & cross-backend regression

### Sandcastle smoke gate (LOCAL-REQUIRED)

`node Tools/visual-regression/sandcastle-smoke.mjs` — the fast (≈1 min) Sandcastle WebGPU gate added in Batch 242. See the probe-inventory entry above for the demo set + pass criteria. Two structural facts drive its existence:

1. **CesiumViewer probes do not cover Sandcastle.** The DepthPlane MRT bug blanked every WebGPU Sandcastle demo for ~115 batches while the whole CesiumViewer-driven probe suite stayed green (the depth plane is inactive in CesiumViewer's default views). Sandcastle's bootstrap (`Viewer.createAsync` + demo script + default home view) is a distinct integration surface — probe it directly.
2. **CI cannot run it.** GitHub-hosted runners expose no WebGPU adapter (the same constraint documented in `.github/workflows/visual-regression.yml`), so this is a LOCAL-REQUIRED gate: run it before committing anything that touches scene-FB render passes, MRT attachment states, the post-process blit chain, or Sandcastle bootstrap code.

### Sandcastle runner

`cross-backend-sandcastle-runner.mjs` loads each Sandcastle demo on both backends and diffs results. Demos that PASS-on-WebGL and FAIL-on-WebGPU are the regression set.

Run after any change that could affect demo-level behavior (renderer, scene logic, feature renderers).

### Variant smoke test

`node Tools/variant-smoke-test.mjs` loads each build variant (`Cesium.js`, `CesiumWebGL.js`, `CesiumWebGPU.js`) in Playwright, asserts no console errors, and verifies a non-uniform frame renders (pixel gate sampled INSIDE `scene.postRender` and polled until a 15 s deadline — Batch 242; a deferred read races the compositor and false-positives black on both backends). Run after any change to the bundle variant plugin, the exemption list, or the entry-barrel generation. See [CLAUDE.md "Build Variants"](../CLAUDE.md).

**CI coverage (Batch 242 NEW-VARIANT-CI; extended Batch 246):** the `variants` job in [.github/workflows/dev.yml](../.github/workflows/dev.yml) runs `npx gulp buildAllVariants` (build-time gate for all three variants — catches the Batch-224 ESM named-re-export class) + the **webgl-only** runtime smoke under headless Chromium/SwiftShader + (Batch 246) the **dual** and **webgpu-only** runtime smokes pinned to the SwiftShader WebGPU adapter via the new `--webgpu-adapter swiftshader` flag, on every push/PR. First-hosted-run caveat: the Linux runner's Chromium must expose the SwiftShader Vulkan WebGPU adapter under that flag (verified locally via the Edge channel; if the hosted run reports "no adapter", revert those two steps to LOCAL-REQUIRED — see NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT in DEFERRED_WORK.md).

**Resolved (Batch 246, NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT):** the previous known-failure — dual/webgpu-only smokes dying at `CreatePipelineLayout` ("sampled textures (31) ... exceeds the maximum per-stage limit (16)") on spec-floor adapters — is fixed by the per-device reduced globe imagery layout (1 imagery slot + multi-pass when `maxSampledTexturesPerShaderStage < 31`). Reproduce the spec-floor environment on a dev box with `--webgpu-adapter swiftshader` (forces `--use-webgpu-adapter=swiftshader`); the deep gate is `probe-globe-default-limits.mjs` (see Probe inventory).

### Visual regression suite

`node Tools/visual-regression/capture-and-diff.mjs` runs every scene in `scenes.json` through three independent visual gates: each renderer against its reviewed historical baseline and current WebGL against current WebGPU. Missing, stale, or unreviewed manifest provenance is `NON_CERTIFYING`, not a pass. See [Tools/visual-regression/README.md](../Tools/visual-regression/README.md) for promotion safeguards, flags, scene-add procedure, and synthetic-scene `setup` / `setupFile` plumbing.

---

## Build variants

```bash
npx gulp buildCesiumDual          # both backends, WebGPU-first default
npx gulp buildCesiumWebGPUOnly    # WebGPU only — GLSL aliased to empty stubs
npx gulp buildCesiumWebGLOnly     # WebGL only — WebGPU renderer aliased to empty stubs
npx gulp buildAllVariants         # all three side-by-side
```

After changes that touch the variant plugin ([scripts/bundleVariantPlugin.js](../scripts/bundleVariantPlugin.js)), the exemption list (`WEBGPU_COMPAT_EXEMPTIONS`), or the entry barrels:

```bash
node Tools/variant-smoke-test.mjs
```

Bundle-size table and full architecture: [CLAUDE.md "Build Variants"](../CLAUDE.md).

---

## When to update this guide

- You add a new `CesiumDebug` command → update the command table.
- You add a new probe → add it to the inventory (correct category).
- You add a new globe-fragment debug mode → update the mode table.
- You add or modify a `scene.debug*`, `globe.*`, `tileset.debug*`, `model.debug*`, or primitive `debugShow*` flag → update the "Upstream Cesium debug surfaces" table.
- You add a new standalone debug primitive or imagery provider → add it to the upstream surfaces section.
- You discover a new Playwright pattern, gotcha, or snippet worth reusing → add it to "Using debug surfaces from Playwright".
- You find a recurring debugging pattern (the same diagnostic sequence solved three bugs) → write it up under a topical section.
- You find an out-of-date entry → fix it in this doc, not in your local notes.

A guide that drifts becomes worse than no guide because it actively misleads. Same maintenance rule as [IMAGERY_PROJECTION.md](IMAGERY_PROJECTION.md): touch this doc whenever you touch a tool it catalogs.

When unsure where something fits: pick the closest existing section rather than creating a new one. New top-level sections only when a real new category emerges (e.g., a Voxel-specific debugging chapter once voxel work is fully shipped).

### C13-41 eclipse-cloud probe closure (2026-08-12)

The historical `probe-eclipse-cloud-response.mjs` inventory row above preserves
the probe's original pre-registration and six-run investigation. Its current
authoritative result is landing-equivalent run
`b5e3f63c-94c6-4204-8706-dd30eabd2eaf`: PASS / exit 0, 30/30 predicates,
report SHA-256
`DD9BA7DCAC0434B91C0F88EFFA4804F3F1CB99747D888B5449B2A483236E70EE`.
The redesigned fresh-session deck-free control is lit and settled, and the
terrain-shadow decrement model passes. The raw post-cloud ratio `1.034120` is
reported-only. The exact selective packet landed as `9c043987a5`, closing
C13-41 / C12-29 S3. This run does not close CLT-B3's separate terminator-specific
WebGL/WebGPU browser gate.
