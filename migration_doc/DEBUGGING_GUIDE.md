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

- **`canvas.toDataURL()` LIES on both backends.** On a **WebGL** canvas without `preserveDrawingBuffer` it returns a **black buffer** (post-present clear). On a **WebGPU** canvas it can come back **Y-flipped** and, at non-power-of-two canvas sizes, **diagonally skewed** (row-stride mismatch) — a black/torn triangle that looks like a render bug but is a readback bug. **Use Playwright element/page `screenshot()` (compositor read) for cross-backend captures**, not `toDataURL`. Let the viewer's OWN render loop run + settle, then screenshot; don't drive `s.render()` manually + `toDataURL`.
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
- **Markers wander or vanish in SCENE2D / Columbus View** — the buffer renderers project RTE world-space ECEF via `modelViewRelativeToEye * projection` with NO 2D/CV reprojected attribute buffer (unlike the Vector3DTile classifiers' CPU-reprojected ENU buffer). SCENE3D is verified (Batch 180); 2D/CV is the open gap. Probe: `probe-bufferpolygon-2dcv.mjs`. (Distinct from `NEW-CLASSIFIER-2D-CV-MORPH`, which is the `.vctr` classifier family.)
- **A non-DOUBLE / `positionNormalized` collection renders garbage positions** — all three renderers assume DOUBLE positions (always `float32x3` high/low RTE); an integer/normalized `positionDatatype` store is read as f64 cartesians. Probe: `probe-bufferpoint-positiondatatype.mjs`.

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

260+ scripts (curated table below — not exhaustive; many are finer-grained bisection variants of the documented gates). Use this table to find an existing probe before writing a new one — most "I need to test X" cases have a template.

> **PROBE_BASE gotcha:** most probes default to `http://localhost:8080`, but `probe-collections-regression.mjs` and `probe-pick-basic.mjs` default `PROBE_BASE` to `:8134`. Against the standard dev server, run them with `PROBE_BASE=http://localhost:8080` or they fail on connection, not on rendering (this bit the 2026-07-03 campaign audit sweep — both pass at `:8080`).

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
| `probe-csm-soft-shadow.mjs` | **PCF soft-shadow gate (Batch 289, NEW-CSM-SOFT-SHADOW-PCF).** Validates the WebGPU cascaded-shadow-map receive path softens the cascade edge with a 3×3 PCF box kernel, matching WebGL's softness. Run after touching the receive-side WGSL PCF kernel or the shadow sampler. |
| `probe-contact-shadows.mjs` | **Contact-shadow gate (Slice 5c-B, Batch 133).** Extruded "wall" polygon over Pittsburgh terrain at a low sun angle; with contact shadows enabled the wall's base casts a short grounded shadow. Run after touching the contact-shadow pass. |
| `probe-globe-effects-handle-toggle.mjs` | **Globe per-view prepared-effects-handle toggle oracle (C9-13, NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE).** Off-gate for the per-(context,frame) memoized globe group-3 effects bind group (`WebGPUGlobeSurfaceRenderer._getOrCreateFrameEffectsBindGroup`). Toggles `globe.clippingPlanes` length 1→0→1 (add plane / `removeAll` / re-add) to drive the memo's active→placeholder→active transition and asserts: (A) clipping ON changes the terrain vs baseline, (B) OFF restores the baseline exactly (no stale clipped hole = memo swapped to placeholder), (C) RESTORE reproduces ON exactly (memo re-armed, not frozen placeholder), (D) 0 errors. Run after touching the globe effects memo, its validity tuple, or `createEffectsBindGroup`. `PROBE_BASE` default :8080. |
| `probe-ellipsoid-rte.mjs` | **Ellipsoid-aware CSM ground-clamp gate (PARITY-RTE-ELLIPSOID-AWARE / FEAT-3DT2-03).** Synthesizes a 0.5×-scaled-ellipsoid globe (no Mars/Moon asset needed) and asserts the CSM `computeVisibleGroundFar` / cascade-split ground positions match the `IntersectionTests.rayEllipsoid` reference on the ACTUAL scene ellipsoid, plus a WebGL-vs-WebGPU umbra-mask IoU on the cast shadow. `--save-baseline` captures the WGS84 off-gate reference (pixel + FP-exact groundFar/splits byte-identity). Run after touching the CSM ground-clamp, `setEllipsoid` threading, or non-WGS84 scene plumbing. |

### Environment / sky / sun / atmosphere

| Probe | What it covers |
| --- | --- |
| `probe-env-skybox-stars.mjs` | **SkyBox star cube-map parity gate (ENV-SKYBOX-STARMAP, 2026-07-02), webgl-vs-webgpu.** Pinned-clock sky-only view (camera 50 Mm up, pitch +90° — no globe/limb/sun in frame), captures cube-map-only (`skyBox.starField.show=false`) and default per backend. Asserts: star-pixel density + mean sky luminance ratios in [0.75, 1.33]; **aligned block-luminance pattern correlation > 0.5 AND > the vertically-mirrored correlation** (catches the cube-face flipY parity bug — WebGL uploads faces with `UNPACK_FLIP_Y_WEBGL=true`, WebGPU must pass `flipY:true` to `copyExternalImageToTexture` or every face mirrors and a different sky region shows); 0 device errors. Also guards the default-off gate of the Phase 1.4 cloud-cover star occlusion (`globe.cloudCoverage` defaults 0.5 — ungated it halved the skybox). Run after touching `WebGPUCubeMapPanoramaRenderer.js`, `CubeMapPanorama.wgsl`, or the weather→star occlusion wiring. |
| `probe-env-moon.mjs` | **Moon disc parity gate (ENV-MOON-SLIVER, 2026-07-02), webgl-vs-webgpu.** Pinned clock (2026-07-02T16:22Z, the user's repro time), reads the moon's world position from `moon._ellipsoidPrimitive.modelMatrix`, parks the camera on the Earth→moon line 20,000 km out and aims at the disc (~190 px). Playwright-screenshot center crop per backend (in-page `drawImage` of the WebGPU canvas can grab a stale frame — the compositor screenshot is authoritative), canvas-decode metrics: lit-pixel ratio in [0.8, 1.25], luminance stddev > 6 on BOTH (textured craters, not a flat disc), disc centers within 40 px, pixel diff < 15%. Guards the model-space RTE convention in `Moon.wgsl` (`rte = posMC − camMC`; a world-space offset gets rotated by the moon's IAU orientation and throws the disc off-screen — the "white sliver" bug) and the zero-specular `Material.ImageType` parity. **Crescent-phase pass (NEW-ENV-MOON-CRESCENT-PROBE, 2026-07-03):** a second capture at ~last-quarter phase (2026-07-08T12:00Z, Simon1994 expected illuminated fraction ≈0.43) gates the B505 phase-terminator shading: partial lit fraction vs the full-disc pass in (0.15, 0.85) per backend, gpu/gl lit ratio in [0.8, 1.25], lit-pixel centroids within 25 px (terminator on the same side), pixel diff < 15%. Run after touching `Moon.wgsl`, `packEllipsoidBaseUniforms`, or `_packMoonUniforms`. |
| `probe-moon-sunlit.mjs` | **Moon "reads as sun-lit, not matte" gate (NS-MOON-MATTE-NOT-SUNLIT, 2026-07-05), both-backends-correct + webgl-vs-webgpu parity.** Premise-verification probe for the user report "the moon renders matte/flat, no sun-relative shading." Result: **premise STALE** — B505 (model-space RTE placement) + B517 (crescent terminator) already ship correct sun-relative shading on both backends. Two per-backend content gates a genuinely flat/emissive disc would fail: (1) **limb darkening** at near-full phase (2026-07-02T16:22Z) — rim-ring/center-ring luminance ratio `limbRatio < 0.6` (measured ≈0.27 both backends; a matte disc → ~1.0), proving a lit Lambert sphere; (2) **graded terminator + sun-facing lit hemisphere** at ~half phase (2026-07-08T12:00Z) — `partialFrac` (lit-area half/full) in (0.15, 0.85), lit-centroid displaced > 0.08·R toward the sunlit limb (measured ≈0.24·R), and ≥3 distinct luminance buckets across the terminator scanline (graded, not a hard step). Cross-backend center-crop pixel diff < 15% at both phases (measured 3.8% full / 0.75% half). Run after touching `Moon.wgsl`, the `czm_private_phong` / `ONLY_SUN_LIGHTING` moon path, `packEllipsoidBaseUniforms`, or `_packMoonUniforms`. |
| `probe-moon-phase-gate.mjs` | **Moon phaseGate blackout gate (C11-176b, 2026-07-24), webgl-vs-webgpu.** Guards the DELETION of the `Moon.wgsl` whole-disc `smoothstep(0.0, 0.3, u.phaseFraction)` multiplier — a WebGPU-only physical double-count (N·L vs the real Simon1994 sun direction already yields terminator + phase) that blacked out the entire disc at small sun-moon elongations (every daytime moon near the sun; the C12-30 "dark blob"). THREE lanes, epochs **derived in-page from Simon1994** (30-day scan, 3 h steps, deterministic — no hardcoded lucky dates): `day-crescent` (phaseFraction 0.005-0.09 — old gate ≤ ~0.10, ≥ 90% blackout, the defect lane; sun > 60° high at the sub-lunar vantage so it's a genuine daytime moon), `crescent` (0.10-0.20 — old gate ~0.35-0.65 partial dimming), `night-full` (0.93-1.0 — old gate exactly 1.0, so this lane isolates the phaseGate from any second cause and must pass before AND after). Moon-disc ROI found by PROJECTING moonPositionWC + a limb point through the camera (no hardcoded pixels; fov 3° so the ~0.5° disc spans >~100 px); metrics = lit-pixel fraction of disc area + mean luminance over lit pixels; parity bands litFrac [0.7, 1.35] / meanLumLit [0.7, 1.4]; blackout detector litFracRatio < 0.3. Atmosphere/skybox/globe/sun/fog hidden → the NS-MOON extinction gate is exactly vec3(1) on both backends (the defect still reproduces: `enableMoonPhase` rode on globe EXISTENCE, not `globe.show`). All Batch-744 probe rules: default loop killed, pinned time on EVERY render, sun-dir settle loop, same-task canvas capture, canvas-element PNGs, rendererType hard-check, WebGL sanity floors (an all-black canvas cannot vacuously pass), 300 s unref watchdog, hard exit codes, **provenance hard-gate** (source `Moon.wgsl` SHA must equal the built copy AND no built bundle may contain `let phaseGate` — exit 2 on a stale build). Companion source spec `moon-phase-gate.spec.mjs` (`node --test`): comment-stripped gate-absence assertions, `var color = lit;` pin, C12-21 scaffolding intact (`phaseFraction` UB member + `ud[67]` pack + `frameState.moonPhaseFraction` publication), EllipsoidFS.glsl stays phase-term-free (parity direction), naga validation. Run both after touching `Moon.wgsl` lighting or `_packMoonUniforms`. |
| `probe-moon-atmosphere-appearance.mjs` | **Moon atmospheric appearance gate (C12 moon wave: C12-30 sky-wash + C12-20 Lommel-Seeliger + C12-23 opposition surge, 2026-07-24), both-backends-correct + webgl-vs-webgpu parity.** Guards the radiative-transfer composite `disc = disc × extinction + inscatter` (the wash comes from the CPU integral `computeAtmosphereInscatter`, which mirrors the sky shader's own scattering model) plus the LS disc law and the SHOE surge. THREE lanes; epochs **derived in-page from Simon1994 by phase window** (60-day scan, 3 h steps) and the **ground observer solved analytically** so moon/sun sit at pinned elevations (up = a·m + b·s + w·(m×ŝ) from the two sin-elevation dot constraints; feasibility + ±3.5° elevation verification are structural gates): `day-mid` (moon ~45°, sun ~40°, pf 0.12-0.40 — gates: sky present ≥25, **darkFrac < 0.15** (the dark-cutout detector: fraction of disc pixels below 0.7× the sky ring), lit peak ≥ ring+25, discMean ≥ ringMean−5), `horizon` (moon ~4°, sun ~25° — gates: lit-peak-above-sky < 0.6× the no-atmosphere control's peak, lit-pixel R/B rises > 1.05× control), `night-full` (moon ~45°, sun −25°, pf 0.88-0.95 — gates: sky ring < 8 mean with > 90% dark pixels [wash ≈ 0 at night], disc stays bright: litFrac ≥ 0.5, meanLumLit ≥ 45 and within [0.5, 1.1]× control). Each lane measures a no-atmosphere CONTROL pass then the ATMOSPHERE pass in one evaluate; cross-backend parity discMean ratio [0.7, 1.4], ring ratio [0.6, 1.6]. All Batch-744 probe rules (pinned clock on every render, settle loop, same-task capture, `locator('canvas')` element PNGs, rendererType hard-fail, sanity floors, 420 s unref watchdog, exit 0/1/2, bounded loops) + **provenance hard-gate**: source `Moon.wgsl` SHA == built copy AND the built bundle must contain `u_atmosphereInscatter`/`LUNAR_BRDF`/`oppositionSurge`/`enableMoonSkyWash` (stale-build guard). Companion source spec `moon-atmosphere-appearance.spec.mjs` (`node --test`, 14 tests): both-backend formula pins (LS `2·μ0/(μ0+μ+1e-4)` character-identical), add-only UB pins (336 B, ud[79..83]), C11-176b contract re-pins, integrator numerics (day wash blue-dominant, horizon whiter/brighter, night + orbit EXACT zero, cache identity/hit), surge curve (I(0)/I(4°) ≥ 1.4, monotone, inert at 90°), naga. Run both after touching `Moon.wgsl`, `EllipsoidFS.glsl`, `computeAtmosphereExtinction.js`, `computeLunarOppositionSurge.js`, or `_packMoonUniforms`. |
| `probe-eclipse-sun-fade.mjs` | **Eclipse / occultation continuous sun fade (C12-29 S1, 2026-07-24), both-backends-correct + toggle-off identity.** Guards `frameState.eclipseState` (limb-darkened dual-cone circle-overlap, `Scene/EclipseState.js` + `Scene/computeSolarObscuration.js`) and its first consumer, the sun billboard ALPHA multiply on BOTH backends (`SunFS.glsl` `u_eclipseAlpha` / the sun WGSL's `eclipseAlpha` in the former `_p2` pad). THREE lanes. **(a) orbital-sunset** — pinned clock, camera swept in 121 equal 0.03° elevation steps from a 400 km vantage through the Earth-limb occultation (the camera moves, not the clock, so the sweep is exactly reproducible): asserts the sun's screen-luminance envelope is CONTINUOUS (`maxStepDelta ≤ 0.20` of peak — pre-fix WebGL drops the whole glow in ONE step at the bounding-volume cull boundary, delta ≈ 1.0), MONOTONE (`maxRise ≤ 0.05`), reaches zero (`lastNorm ≤ 0.02` — pre-fix WebGPU never culls and never dims, so its glow persists forever), starts bright (`firstNorm > 0.5`, absolute floor `peak > 2000` so a black canvas cannot pass), sweeps the full physics range (fraction 1 → 0), and `sunEclipseAlpha === sunVisibleFraction` bit-for-bit. **(b) eclipse-2026** — the 2026-08-12 partial instant, epoch + ground vantage **derived in-page from Simon1994** (2 regions × 3×3 lat/lon grid × 301 minute samples, then stepped off the maximum into the 0.40–0.65 obscuration band so the linearity is measurable; the probe's own uniform-disc implementation locates the instant, the ENGINE's limb-darkened value is what is asserted): `sunVisibleFraction < 1`, the MOON is the occluder (`moonObscuration > 0.2`, `earthOcclusionFraction === 0`) with `scene.moon.show = false` (an eclipse must dim the sun whether or not the decorative moon draws), and the measured glow ratio ON/OFF tracks the fraction linearly. **(c) toggle-off** — measured IN THE SAME STEPS as lane (a), not in a second sweep. **REDESIGNED TWICE (2026-07-24); every failing check was a check-design flaw, never an engine defect.** v1's `legacyBehaviourRestored` asked the LUMINANCE metric to show WebGL's binary pop, which is geometrically unobservable — the cull can only fire once the Earth's limb already covers the glow annulus, so the metric is ≈0 in BOTH toggle positions (measured WebGL OFF `maxStepDelta` 0.03, WebGPU OFF `lastNorm` 0). v1's `byteIdenticalWhereUnoccluded` compared canvas hashes ACROSS two sweep runs, which `czm_frameNumber`-driven animation makes non-deterministic. v2 kept the two-sweep shape, and that alone broke three more things: the identity tolerance was missed (0.027 vs 0.02) because 60–78 of 121 steps ran on unsettled globe tiles whose limb pixels differ between runs; the saturation mask could not be shared across two `page.evaluate` calls, so WebGPU's additive clamp pushed its band ratio to ≥ 0.8 while WebGL read 0.515; and the `isSunVisible` read was corrupted by the sun-hidden render. **v3 measures both toggle positions inside one step** — four renders per step, `{eclipse off, on} × {sun shown, sun hidden}` — which deletes the cross-run axis entirely (same tiles, same frame-number neighbourhood, one shared mask) at zero extra rendering cost. Current checks: `alphaExactlyOne` (published alpha exactly `1` with the effect off — the identity proof, `x * 1.0 === x`), `toggleObserved` (`eclipseState.enabled` flipped both ways every step), `physicsStillComputed` (fraction still sweeps 1 → 0 when off), **`cullStateUnchanged`** — the legacy binary cull's per-step state (`isSunVisible`, `hasSunCommand`, `sunCommandHasBV`) is IDENTICAL on and off, read via a `scene.postRender` listener that ignores sun-hidden frames; this is the real "S1 did not touch the cull" pin and it holds whether or not the cull ever fires — `cullNonVacuous` (≥1 step actually un-culled), `boundingVolumeShape` (WebGL's sun `DrawCommand` carries a bounding volume, WebGPU's `WebGPUDrawCommand` carries none — the structural backend fact, independent of firing), `identityWhereUnoccluded` (`abs(glowOn − glowOff) / max(glowOff,1) ≤ 0.02` over steps with `fraction === 1` **and settled tiles**, requiring ≥5 such steps; falls back to 0.05 over all unoccluded steps only if fewer, with `identityRelaxedReason` recorded, and structural if none), and `eclipseVisiblyApplied` — a **three-tier, non-vacuous-by-construction** band gate, because the round-3 run returned a null ratio on WebGPU: its additive blend saturates the inner glow to 255 with the effect off, and the saturation mask then discards exactly the sun-bearing pixels, leaving only globe pixels whose difference is 0. Tier 1 `primary-masked` — brightness-weighted ratio `sum(glowOn) / sum(glowOff) < 0.8` over partial-band steps with ≥300 unsaturated px inside 1.5×..6× the limb radius, requiring ≥5 such steps (WebGL lands here: measured 0.491 == expected 0.491). Tier 2 `wide-masked` — same gate with the mask sourced from the wider 1.5×..10× annulus (the ROI was widened 6.5× → 10.5× for this; the glow falls off radially, so the outer ring still holds unsaturated sun-bearing pixels). Tier 3 `raw-strict` — over the **unmasked** 1.5×..6× annulus, require `glowOnRaw < glowOffRaw` at EVERY partial-band step (≥5 steps); saturation can only understate the dimming, so this one-sided count can never manufacture a pass. **The asymmetry is mask SOURCING only** — within any single step `glowOn` and `glowOff` always sum over the identical pixel set, so every ratio compares like with like; the tier used plus `bandTierReason` are recorded so a fallback can never pass silently. **Tier NA `NA-geometric-limb` (WebGPU only, measured):** the round-4 run found `glowOnRaw == glowOffRaw == 0` at ALL 15 partial-band steps (fraction 0.990 → 0.001, effect off AND on) — **the WebGPU sun's glow does not extend above the earth limb at all**, so no eclipse effect could be observed in that band no matter how it were implemented. That is a PRE-EXISTING backend sun-RENDERING divergence (filed as measured evidence on the `C12-15`/`C12-16`/`C12-17` rows; C12-16's terminating `1-smoothstep(0,0.55,r)` glare falloff and C12-17's fixed 256² 8-bit bake are the co-suspects), not an S1 defect. The probe detects it BY MEASUREMENT (`partialGlowOffRawMax === 0`, recorded with `partialGlowOnRawMax`), reports the NA tier with its reason string, and **formally requires lane (b)'s `alphaIsLinear` + `partialEclipse`** — the open-sky moon eclipse, where the sun is high and nothing occludes the annulus — so the proof is delegated explicitly, never exempted (verified: lane (b) red ⇒ lane (c) fails; non-zero glow ⇒ normal `raw-strict`; WebGL never takes this arm). `crossToggle.deferredToLaneB` records the delegated results. **Until the C12-15..17 sun-appearance wave lands, visible earth-limb dimming is unobservable on WebGPU and the moon-eclipse lane is the WebGPU proof of eclipse-alpha application.** **Whether the legacy cull fires is REPORTED, not gated** (`cull.onFlipStep`, `offFlipStep`, `visibleStepCount`): the sun's glow bounding volume is ~4.2e9 m against a ~6.4e6 m Earth occluder, so `Occluder.isBoundingSphereVisible` takes its rarely-exercised "occludee larger than occluder" path — as it happens it DOES fire on WebGL (round-3: `visibleStepCount` 77, `onFlipStep == offFlipStep == 77`), but gating on that would still be asserting a premise the invariance gate already covers either way. Also reported: `bandRatioMeasured` vs `bandRatioExpected` (`sum(glowOff·f) / sum(glowOff)`), `partialStepsOverFloor{Primary,Wide}`, `partialMaskedPx{,Wide}{Min,Max}`, `tiles.settledSteps`, `meanSaturatedFrac`, and a 4-bin radial `meanSaturationProfile` / `partialSaturationProfile` across 1.5×..10× showing WHERE the additive blend clamps. MEASUREMENT: each step renders FOUR times at the same pinned time/camera — `{eclipse off, on}` × `{sun shown, sun hidden}` — and integrates \|luminance difference\| over the glow annulus (1.5×..6× the projected solar limb radius). That difference image isolates the sun exactly, is zero where the globe covers it, and scales EXACTLY linearly in alpha under both blend states (`ALPHA_BLEND` gives `out − dst = a·(src − dst)`, additive gives `out − dst = a·src`). Both sums share ONE mask built from the eclipse-OFF (brightest) capture with 8-bit-saturated pixels excluded — WebGPU blends additively and an un-faded sun clamps at 255, which otherwise pulls that backend's ratio toward 1. Four renders per step across one sweep costs exactly what two renders per step across two sweeps cost. `scene.sunBloom` forced OFF (WebGPU's is unwired, C11-160). All fleet probe rules (pinned clock on every render, sun-dir settle loop, same-task capture, `locator('canvas')` element PNGs, rendererType hard-fail, sanity floors, 420 s unref watchdog, bounded loops, exit 0/1/2) + **provenance hard-gate**: the exact new source lines (read out of the source at run time, never hardcoded) must appear VERBATIM in the built bundle, all of `u_eclipseAlpha`/`eclipseAlpha`/`sunEclipseAlpha`/`enableEclipse`/`sunVisibleFraction`/`earthOcclusionFraction`/`moonObscuration` must be present, and the bundle mtime must be newer than every touched source. Companion pure spec `eclipse-state.spec.mjs` (`node --test`, 28 tests). Run both after touching `EclipseState.js`, `computeSolarObscuration.js`, `Sun.js`, `SunFS.glsl`, the sun WGSL/`packSunUniforms`, or the `isSunVisible` cull in `Scene.updateEnvironment`. **This probe is the regression gate the S1-before-C12-18/C11-160 pin (maintainer ruling E5) exists to create — run it before and after the sun-PP refactor.** |
| `probe-ground-view-env.mjs` | **Regression gate for the three ground-level environment divergences (Batch 247, NEW-GROUND-VIEW-ENV-DIVERGENCES), webgl-vs-webgpu same-scene numeric.** (1) ground-sky brightness — mean-luminance + HSB-value ratio over the top sky band, band [0.8, 1.25] (post-fix 0.99x/0.99x; pre-fix 1.73x/1.46x — caught the over-converged quadrature + non-WebGL shell geometry + LUT azimuth bug); (2) sun disk at a sun-aimed ground view — bright-pixel count within 180 px of frame center, atmosphere ON must keep the disk (caught the binned-sun-under-injected-skyAtmosphere ordering bug) with an atmosphere-OFF control; (3) no-imagery globe baseColor — exact pixel vs `globe.baseColor` rgb(31,38,51) (caught the hardcoded WGSL base). Writes `output/ground-view-env/{basecolor,sky,sun-atmo-on,sun-atmo-off}.png` per backend. Run after any change near SkyAtmosphere, Sun, the env-command injection (SceneRenderer.js), or the globe first-pass base color. |
| `probe-ground-atmosphere.mjs` | Globe ground-atmosphere drape (the inscatter-LUT FOG-drape consumer): groundAtmosphere ON vs OFF with skyAtmosphere hidden, non-black + ON/OFF-diff pixel gates; also asserts retired `FeatureRendererKey` 29 stays `undefined`. The LUT bake is still alive even though the SKY shader's LUT consumption is gated off (Batch 247) — this probe is the LUT's live regression guard. |
| `probe-limb-halo-width.mjs` | **SkyAtmosphere shell limb-width gate + ground-atmosphere drape limb diagnostic (Batch 327; re-validated Batch 513 NEW-GLOBE-DRAPE-LIMB-CLOSEOUT), webgl-vs-webgpu.** GATE: globe.show=false + drape off + pure-black space isolates the shell — measures the median blue rim-band width at the disk L/R edges, asserts \|Δ\| ≤ 6 px (Batch 513: WebGL 14 px vs WebGPU 16 px). This scene is the ONLY default-ish framing where the disk interior isn't globe-covered, so it guards the through-planet extinction march in `SkyAtmosphere.wgsl::skyColorForRay`/`computeScattering` (the pre-513 earth-surface ray clip flooded the interior solid blue and truncated the ~10 px limb extinction tail — masked before 2026-06-25 by the skybox-over-atmosphere draw-order bug). DIAGNOSTIC (report-only): globe + drape ON, same measurement (Batch 513: 1 px vs 1 px, delta 0 — the drape band is at parity). Run after touching `SkyAtmosphere.wgsl` scattering/ray math or the sky draw order. |
| `probe-confirm-inspector-sky.mjs` | **Cross-backend ground-view sky comparison.** `RENDERER=webgl\|webgpu` + `CLOUDS=on\|off`, applies a 650 m ground config (`skyAtmosphere.show`), compositor `page.screenshot` (NOT toDataURL), asserts capture-time camera height = 650 m, measures **upper-center sky mean RGB**. Surfaced BUG-WEBGPU-SKY-GROUNDVIEW-HIGH-ELEVATION-BLACK: WebGPU upper sky `(1,1,1)` black vs WebGL `(75,123,176)` blue, identical with clouds on/off. **The harness template for the deferred sky-shell-coverage fix** — extend it to sample multiple elevations (the existing `probe-ground-view-env` gate only samples the horizon band and is blind to the zenith blackness). |
| `probe-weather-inspector.mjs` | End-to-end gate for the `WebGPU Weather Inspector` gallery demo: boots the gallery `.html` standalone (see the gallery-demo boot recipe under Cross-backend / Sandcastle), drives real DOM sliders + a preset button, compositor-screenshots, asserts the panel builds + Coverage drives the deck + a preset refreshes the UI + 0 errors. |
| `probe-weather-presets.mjs` | **Standards-keyed preset sweep (Batch 405).** Clicks all 8 METAR/WMO presets (SKC/FEW/SCT/BKN/OVC/Ns/Cb/Ci) and verifies the deck-wedge **luminance okta-ladder** holds (clear/sparse > broken > overcast/storm) + clear-vs-overcast and few-vs-storm whole-frame diffs. NOTE the metric is luminance, not a "bright cloud %": heavy decks render DARK grey under their own dim light, so a brightness ladder separates the okta scale; a whitish-pixel count misses the storm decks. |
| `probe-cloud-diagonal.mjs` | **Regression guard for the Batch 406 half-screen-clouds fix (oversized fullscreen triangle).** OVC St ground view; the pre-fix bug rasterized only the lower-left half, so the deck filled bottom-LEFT and bottom-RIGHT was ~0. Asserts the deck is **left-right symmetric** (bottom-left ≈ bottom-right, both > 50%) → no TL→BR diagonal. The deck legitimately thins toward the zenith (thin deck, short straight-up path) — that's NOT the bug; the regression signature is the bottom-half left/right asymmetry. |
| `probe-cloud-dials.mjs` | **Batch 407 struct-growth dials wiring + byte-identity.** Drives `globe.cloud{PuffSize,Exposure,MsDecay*}`: asserts explicit-defaults == undefined (diff 0, byte-identical), reset == default (diff 0), exposure + puff-size change the render. (Exposure's mean-luminance move is tiny — the deck is near the Reinhard knee — so it asserts a whole-frame DIFF, not a brightness direction.) |
| `probe-cloud-genus.mjs` | **Batch 408 V11 per-genus types.** Drives `globe.cloudType`: CUMULUS == default (byte-identical), CIRRUS renders a thinner deck (~0.21× density scale), CIRRUS + Cb substantially change the render, STRATUS differs. Raises coverage to 0.8 first so the per-genus density scale reads; the upward demo camera compresses the vertical (towering) structure, so density-scale is the dominant visible lever — a side view would show the tower/slab shape better. |

### Post-process / effects

| Probe | What it covers |
| --- | --- |
| `probe-bloom-parity.mjs` | **Bloom uniform parity gate (Batch 240, NEW-BLOOM-UNIFORM-PARITY), webgl-vs-webgpu.** Default-uniform bloomed-pixel fraction ratio band [0.2x, 2x], glowOnly + brightness uniform response, 0 errors. Scene strips all backend-divergent env elements (sky/sun/skybox/imagery/water) — the ground-view divergences it documented are now fixed under NEW-GROUND-VIEW-ENV-DIVERGENCES (Batch 247). |
| `probe-taa-resolve.mjs` | **Regression gate for the Batch 244 TAA resolve activation** (NEW-TAA-EFFECT-NEVER-ADDED): TAA OFF→ON→OFF. OFF → no `_taaEffect`, msaa=4, baseline renders; ON → effect lazy-added + enabled, the resolve pass ENCODES (debug-pragma `resolveCount` strictly increases), velocity attaches, msaa=1, 60 moving frames 0 errors, settled scene temporally STABLE (consecutive-frame diff < 1%) and NOT smeared (camera rotation below the teleport threshold → image follows within one frame, billboard pixel count doesn't ghost-double); OFF → bypass (instance kept, `enabled=false`, `resolveCount` frozen), velocity detaches, msaa restored. Run after any change near the TAA effect, the post-process configure pass, or the TAA↔MSAA coupling. |
| `diag-taa-black.mjs` | One-off device-`pushErrorScope` diagnostic that found the Batch 244 latent failures (depth+filtering sampler pipeline rejection; G-buffer MSAA mismatch killing the scene pass). Template for "pass runs but output black with 0 console errors" investigations — uncaptured validation errors don't always reach the console; an explicit error scope catches them. |
| `probe-bloom-no-globe.mjs` / `-no-msaa.mjs` / `-no-pp.mjs` / `-no-sky.mjs` / `-side-by-side.mjs` / `-tile-state.mjs` | Bloom bisection variants |
| `probe-msaa-comparison.mjs` | MSAA on vs off |
| `probe-tonemap.mjs` / `-gamma-chain.mjs` | Tonemap + gamma chain |
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
| `probe-cmd-pushes.mjs` / `-pass-counts.mjs` / `-trace-counts.mjs` | Command / pass counts per frame |
| `probe-console-errors.mjs` | Console-error stream |
| `probe-debug-snapshot.mjs` | `scene.getDebugSnapshot()` dump |
| `probe-draw-calls.mjs` / `-draw-pipeline-labels.mjs` / `-direct-draw-fb.mjs` | Draw-call instrumentation |
| `probe-fb-after-draws.mjs` / `-fb-config.mjs` / `-sceneframebuffer.mjs` | Framebuffer state |
| `probe-gpu-tex.mjs` / `-tex-format.mjs` | GPU texture format |
| `probe-gpu-timestamp-profiler.mjs` | Real-adapter timestamp capability, opt-in lifecycle, post-submit readback, named core-pass samples, and browser error gate |
| `probe-webgpu-allocation-tax.mjs` | Independent Node/Edge API-boundary allocation/upload/pass/submit probe. Fails if explicit WebGPU opens WebGL/WebGL2; `--strict-native` additionally rejects `GL Compatibility` buffer labels for migrated fixtures. It reports `GLStub_*` textures as compatibility-shaped without calling them duplicates: they may be the sole physical realization. Buffer bytes are exact, texture bytes are descriptor estimates, and decoded/backend ownership evidence is still required. |
| `run-performance-campaign.mjs` + `performance-workloads.json` | Versioned deterministic Node/Edge workload runner. Captures full-Scene CPU p50/p95/p99/MAD, capability-available GPU timestamps/remainder, long tasks/heap diagnostics, startup, and renderer snapshots. CPU/GPU metrics are primary; rAF wall time is diagnostic and may be refresh-limited. |
| `probe-magenta-clear.mjs` / `-webgpu-grey.mjs` | Sentinel-color clear checks |
| `probe-shim-debug.mjs` / `-shim-trace.mjs` | GLSL→WGSL stub-translator tracing |
| `probe-wgsl-doctype.mjs` | WGSL parse sanity |
| `probe-vec4-error.mjs` | vec4 layout error reproduction |

### Async / streaming

| Probe | What it covers |
| --- | --- |
| `probe-async-resource-monitor.mjs` | Async resource lifecycle |
| `probe-empty-scenes.mjs` | Scenes with nothing to render (background / clear) |
| `probe-globe-timing.mjs` | Tile selection timing |
| `probe-replay-cesium-cmd.mjs` | Replay a captured Cesium command stream |

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
| `sandcastle-batch-66-runner.mjs` / `-final-runner.mjs` / `-end-of-session-runner.mjs` | Batch-specific Sandcastle runners |
| `analyze-cross-backend-report.mjs` | Post-process the cross-backend report |

#### Booting a gallery demo standalone in a probe

Gallery `.html` files (`Apps/Sandcastle/gallery/*.html`) reference `../Sandcastle-header.js`, `../load-cesium-es6.js`, and `../templates/bucket.css`, which **404 when served standalone on :8080** (they only exist inside the Sandcastle2 build context, which extracts the `//Sandcastle_Begin…End` block and runs it in a booted iframe). So a demo's own `window.startup` is defined but never auto-called, and `cross-backend-sandcastle-runner.mjs` times out on the canvas wait. To verify a demo in a custom probe, replicate the boot (see `probe-weather-inspector.mjs`):

1. `page.addInitScript` a minimal `window.Sandcastle` stub whose `finishedLoading()` clears `document.body.classList.remove("sandcastle-loading")` + hides `#loadingOverlay` (bucket.css is 404, so do it directly).
2. `goto` the demo URL, then `page.addStyleTag` the sizing bucket.css normally provides: `#cesiumContainer{position:absolute;top:0;left:0;width:100%;height:100%}`.
3. `page.evaluate`: `const C = await import("/Build/CesiumUnminified/index.js"); window.Cesium = C; await window.startup(C);` — call the demo's OWN startup with the injected Cesium.
4. `armWebGPUDevices(page)`, wait for `window.viewer`, let the render loop settle, then **compositor `page.screenshot`** (not toDataURL — see the cross-backend capture pitfalls in the Visual artifact playbook).

Note: `sandcastle-smoke.mjs` loads 3 renderer-pinned WebGPU demos at their standalone URLs successfully without this shim (it patches `GPUAdapter.requestDevice` for the error gate) — those demos happen to bootstrap; use it as the reference for the demos it covers, and the recipe above for new demos that don't.

Gallery demo `.html` is eslint-linted **as a module**: no top-level `"use strict"`, add `/* global Cesium, Sandcastle */`, `eqeqeq` (no `== null`), `prefer-template`. The old committed demos are grandfathered; new ones must pass.

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

The pick framebuffer is its own render path — `CesiumDebug.snapshot()` reports its state. Pick failures often show up as "scene.pick returns undefined" without any visible artifact — the failure is in the depth blit or the pick texture, not the main render.

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
