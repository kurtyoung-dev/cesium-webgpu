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
│   ├── CesiumDebug.cpuPassCost(true) / .gpuPassCost() / .highDensityCull()
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

Call `CesiumDebug.globeFragmentDebug()` with no args to get the live list from the registry.

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
| `gpuPassCost()` | GPU per-pass timing (timestamp-query) | — | ✓ |
| `highDensityCull()` | GPU culler / HiZ / sort-keys stats (Batch 217) | — | ✓ |
| `hiZConsume(on)` | FORK-41 (Batch 291) — toggle whether Hi-Z occlusion DROPS occluded commands (default OFF; build/dispatch/readback always run, result inert until the residual OcclusionTest correctness fix lands — see DEFERRED_WORK FORK-41) | — | ✓ |
| `globeBindGroups()` | Globe bind-group cache stats (Batch 241) — healthy steady-state: `lastFrameCreates` ~0, high `hitRate` | — | ✓ |
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
CesiumDebug.gpuPassCost();         // GPU side (needs timestamp-query feature)
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
| [capture-and-diff.mjs](../Tools/visual-regression/capture-and-diff.mjs) | Multi-scene visual regression suite (`scenes.json`). Run before claiming "no regression" on a big change. See [Tools/visual-regression/README.md](../Tools/visual-regression/README.md). **Batch 207:** now also runs the WebGPU error/crash gate — a scene that renders the right pixels while emitting validation errors / losing the device now FAILS. |
| [lib/webgpu-error-gate.mjs](../Tools/lib/webgpu-error-gate.mjs) | **Shared WebGPU error/crash gate** (Batch 207). Catches uncaptured validation errors (`device.onuncapturederror`) + device-loss (`device.lost`) + WebGPU-fault console prints, so a harness FAILS on the FORK-34 class (engine spews GPU errors but the page limps on). Wired into `variant-smoke-test.mjs` + `capture-and-diff.mjs`; import `errorGateInit` / `armWebGPUDevices` / `collectGateErrors` / `attachConsoleErrorGate` into any new Playwright harness. Self-tested by `probe-error-gate-selftest.mjs`. |
| [probe-debug-api.mjs](../Tools/visual-regression/probe-debug-api.mjs) | End-to-end test of `CesiumDebug.globeFragmentDebug()`. Template for testing new CesiumDebug commands. |
| [probe-brightness-ratio.mjs](../Tools/visual-regression/probe-brightness-ratio.mjs) | Measures WebGL/WebGPU per-globe-pixel mean-RGB ratio across 5 camera distances. Writes `output/brightness-ratio-report.json` for trend tracking. Template for any "is backend X darker than backend Y?" measurement. **Critical:** compute per-globe-pixel (not full region) — globe-size differences in the screenshot will bias full-region averages. |
| [probe-brightness-no-atmo.mjs](../Tools/visual-regression/probe-brightness-no-atmo.mjs) | Brightness ratio variant with `globe.showGroundAtmosphere = false`. Isolates the imagery-composite path from the drape branch — if the gap persists here, the bug is in composite (Batch 58) or earlier. |
| [probe-brightness-bisect.mjs](../Tools/visual-regression/probe-brightness-bisect.mjs) | Compares `final` vs `post-composite-color` vs `sample0` vs `sample1` at multiple camera altitudes. Surfaces whether dimming happens at the texture sample, the composite chain, or downstream effects. |

### Globe / imagery / projection

| Probe | What it covers |
| --- | --- |
| `probe-globe-underground.mjs` | **GLOBE-UNDERGROUND-COLOR acceptance + regression gate (2026-07-02).** Camera 30 km below the surface: (a) red `globe.undergroundColor` + custom `undergroundColorAlphaByDistance` ramp vs WebGL, (b) upstream-default underground look, (c) above-ground default off-gate. Judged relative to the above-default standing residual (imagery-LOD/atmosphere, ~22%). Guards the underground tint AND the Bug 487 fixes (no-cull pipeline-name aliasing, fog-off-underground, skirt suppression). |
| `probe-globe-polar-stretch.mjs` | **GLOBE-POLAR-STRETCH acceptance + regression gate (2026-07-02, extended by GLOBE-POLAR-STRETCH-POLISH 2026-07-03).** Three zooms (mid 2 Mm / far 25 Mm / extreme 55 Mm), WebGL vs WebGPU, default viewer. Disc-normalized latitude-band metrics (ice/Greenland centroid Y, top-half land-profile shift, ice area ratio) + tightened mismatch ceilings (mid 0.27% / far 3.5% / extreme 4.5%) + a **bucket decomposition** of the residual (space stars / limb ring / interior thin AA / interior blobs split by brighter backend) with a dark-navy tile-seam fingerprint gate (BUG-GLOBE-TILE-SEAM-LINES must stay ≈ 0 — guards the fragment-entry UV clamp in `GlobeTerrain.wgsl`). Also guards the `ReprojectWebMercator.wgsl` orientation fix (far-zoom latitude-mirror warp) and the `czm_getSpecular` ocean-glint port. Run after ANY change to the reprojection chain, imagery texture variant selection, imagery samplers, or the globe ocean/specular path. Writes per-view bucket-mask PNGs + report.json to `output/globe-polar-stretch/`. |
| `probe-globe-translucency.mjs` | **`globe.translucency` front/back alpha gate (GLOBE-TRANSLUCENCY-ALPHA, Batch 488), webgl-vs-webgpu.** Three legs: front-face-only translucency (alpha 0.5), a `frontFaceAlphaByDistance` ramp, and the default-off off-gate (camera-UB translucency tail all-zero + `control.x=0` keeps the FS on the historical path — byte-identical default rendering). Guards the GlobeFS→GlobeTerrain.wgsl `interpolateByDistance` alpha port, the ALPHA-blend/depth-write-off front-face pipeline selection + `_DOF` depth-only pre-pass (WebGL `getDerivedCommandTypes` pass-structure parity), and the `SkyAtmosphere.wgsl` GLOBE_TRANSLUCENT port gated on `atmosControl.w` (without it the WGSL sky floods the see-through planet disk with daylight blue — the fix that took terrain diff 99.8%→22.9%). **Known standing FAIL (2026-07-03 audit): translucent-terrain 25.49% vs a 10.5% dynamic limit** — the campaign's default-view polish tightened the shared baseline (~15%→2.5%) onto a below-surface/atmosphere darkening residual that measured 22.9% at B488's own landing (WebGPU uniformly darker, dRGB −5.9..−6.7). Tracked with `probe-globe-underground`'s twin numbers; do NOT loosen the limits. Run after touching the translucency camera/tile-UB tails, the derived-pipeline selection, or the SkyAtmosphere translucent gate. |
| `probe-globe-clippoly-geodetic.mjs` | **`globe.clippingPolygons` end-to-end gate (GLOBE-CLIPPOLY-GEODETIC, Batch 494), webgl-vs-webgpu.** A clipping polygon over the globe: clipped-region and inverse-mode pixel parity via screenshot diff, plus the default off-gate (no polygons → `clippingPolygonControl` zero, clip path skipped, rendering unchanged). Guards the whole B494 wiring chain: `packDataForFeatureRenderer()` (the shared CPU pack — spherical `fastApproximateAtan2` coords + merged extents), the upstream `[header\|extent×2\|vertices]` rg32float upload + canonical `PolygonSignedDistance.wgsl` compute in `WebGPUClippingPolygonCollection.ts`, the effects-bind-group producer-field read, and `globeClipByPolygon(v_positionMC)` in `GlobeTerrain.wgsl` — a verbatim parity port of `modelClipByPolygon` using the SPHERICAL fast-atan convention matching `czm_approximateSphericalCoordinates` (NOT geodetic conversion, which would mismatch upstream). Run after touching any of those, the SDF atlas sizing, or the `EffectsUniforms` clipping tail (whose byte-parity padding also fixed the latent Batch-108 `pointLightControl` misalignment). |
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
| `probe-classifier-textured-materials.mjs` | **Textured-material GroundPrimitive** (Color / Stripe / Checkerboard / Grid) in SCENE3D, WebGL vs WebGPU. Sub-1° polygon + polygon-interior ROI + lit-pixel-only **variance** signal (flat color → variance ~0; patterned material → high variance). Flat textured-material classification (Color/Stripe/Checkerboard/Grid) now **SHIPPED Batch 185** (`88b111e49c`): the `packExtents` wrapper-chain walk ([WebGPUGroundPrimitiveRenderer.js:313](../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js)) fixed a 1-hop-too-deep inner-`_primitive` lookup that was writing `materialMeta.x=0` and forcing the flat-color fast path — the earlier "BLOCKED on globe depth precision" framing was wrong (root cause was wrapper depth, NOT depth precision). The genuine open residual is **`NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION`** (far-corner reconstruction-precision; legitimately log-depth-gated — Checkerboard degrades toward the far corner while Stripe stays clean), tracked in [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md). NOTE: identical non-zero red-px across all modes is a tell for a JS error-dialog (salmon background), not classification output. |
| `probe-classifier-2d-renderpass.mjs` | Focused diagnostic for **cascading render-pass-lifecycle errors**: drives the 2D GroundPrimitive path, captures the FIRST thrown exception + stack + the leaked render-pass label (not the masking `beginFrame` cascade). Template for `_beginDefaultRenderPass() called with an active render pass` bugs. |
| `probe-vr2-polylines-3dtiles.mjs` | BIM Power Plant tileset (ion asset 2464651) + clampToGround classification polyline, WebGL vs WebGPU saturated-panel pixel count (NEW-VR2-5 reproduction — no longer reproduces). Needs network + ion. |
| *Vector3DTile classifier 2D/CV (Batch 178)* | **VERIFICATION GAP — no probe exists yet.** `Vector3DTilePrimitive` 2D/CV is implemented but cannot be Playwright-verified: the repo has no classic `.vctr` sample tileset (the only producer of `Vector3DTilePrimitive` content) and its internal classes aren't bundle-exported, so no synthetic scene is stampable. The modern sample vector tilesets (`Apps/SampleData/vector/*`) route through `BufferPolygon` (a different renderer), NOT `Vector3DTilePrimitive`. The BufferPolygon `#import` compile failure (NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT) is **RESOLVED Batch 180** (`3667945dae`; the preprocessor now resolves bare `#import` from `BUFFER_WGSL_CHUNKS`, 593 device errors → 0 on sample-us-states — see `probe-bufferpolygon-vector-tile.mjs`), so the BufferPolygon path is no longer the blocker. A scenemode probe + `.vctr` test data is still owed for `Vector3DTilePrimitive` 2D/CV specifically. |

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
| `probe-ellipsoid-rte.mjs` | **Ellipsoid-aware CSM ground-clamp gate (PARITY-RTE-ELLIPSOID-AWARE / FEAT-3DT2-03).** Synthesizes a 0.5×-scaled-ellipsoid globe (no Mars/Moon asset needed) and asserts the CSM `computeVisibleGroundFar` / cascade-split ground positions match the `IntersectionTests.rayEllipsoid` reference on the ACTUAL scene ellipsoid, plus a WebGL-vs-WebGPU umbra-mask IoU on the cast shadow. `--save-baseline` captures the WGS84 off-gate reference (pixel + FP-exact groundFar/splits byte-identity). Run after touching the CSM ground-clamp, `setEllipsoid` threading, or non-WGS84 scene plumbing. |

### Environment / sky / sun / atmosphere

| Probe | What it covers |
| --- | --- |
| `probe-env-skybox-stars.mjs` | **SkyBox star cube-map parity gate (ENV-SKYBOX-STARMAP, 2026-07-02), webgl-vs-webgpu.** Pinned-clock sky-only view (camera 50 Mm up, pitch +90° — no globe/limb/sun in frame), captures cube-map-only (`skyBox.starField.show=false`) and default per backend. Asserts: star-pixel density + mean sky luminance ratios in [0.75, 1.33]; **aligned block-luminance pattern correlation > 0.5 AND > the vertically-mirrored correlation** (catches the cube-face flipY parity bug — WebGL uploads faces with `UNPACK_FLIP_Y_WEBGL=true`, WebGPU must pass `flipY:true` to `copyExternalImageToTexture` or every face mirrors and a different sky region shows); 0 device errors. Also guards the default-off gate of the Phase 1.4 cloud-cover star occlusion (`globe.cloudCoverage` defaults 0.5 — ungated it halved the skybox). Run after touching `WebGPUCubeMapPanoramaRenderer.js`, `CubeMapPanorama.wgsl`, or the weather→star occlusion wiring. |
| `probe-env-moon.mjs` | **Moon disc parity gate (ENV-MOON-SLIVER, 2026-07-02), webgl-vs-webgpu.** Pinned clock (2026-07-02T16:22Z, the user's repro time), reads the moon's world position from `moon._ellipsoidPrimitive.modelMatrix`, parks the camera on the Earth→moon line 20,000 km out and aims at the disc (~190 px). Playwright-screenshot center crop per backend (in-page `drawImage` of the WebGPU canvas can grab a stale frame — the compositor screenshot is authoritative), canvas-decode metrics: lit-pixel ratio in [0.8, 1.25], luminance stddev > 6 on BOTH (textured craters, not a flat disc), disc centers within 40 px, pixel diff < 15%. Guards the model-space RTE convention in `Moon.wgsl` (`rte = posMC − camMC`; a world-space offset gets rotated by the moon's IAU orientation and throws the disc off-screen — the "white sliver" bug) and the zero-specular `Material.ImageType` parity. Run after touching `Moon.wgsl`, `packEllipsoidBaseUniforms`, or `_packMoonUniforms`. |
| `probe-ground-view-env.mjs` | **Regression gate for the three ground-level environment divergences (Batch 247, NEW-GROUND-VIEW-ENV-DIVERGENCES), webgl-vs-webgpu same-scene numeric.** (1) ground-sky brightness — mean-luminance + HSB-value ratio over the top sky band, band [0.8, 1.25] (post-fix 0.99x/0.99x; pre-fix 1.73x/1.46x — caught the over-converged quadrature + non-WebGL shell geometry + LUT azimuth bug); (2) sun disk at a sun-aimed ground view — bright-pixel count within 180 px of frame center, atmosphere ON must keep the disk (caught the binned-sun-under-injected-skyAtmosphere ordering bug) with an atmosphere-OFF control; (3) no-imagery globe baseColor — exact pixel vs `globe.baseColor` rgb(31,38,51) (caught the hardcoded WGSL base). Writes `output/ground-view-env/{basecolor,sky,sun-atmo-on,sun-atmo-off}.png` per backend. Run after any change near SkyAtmosphere, Sun, the env-command injection (SceneRenderer.js), or the globe first-pass base color. |
| `probe-ground-atmosphere.mjs` | Globe ground-atmosphere drape (the inscatter-LUT FOG-drape consumer): groundAtmosphere ON vs OFF with skyAtmosphere hidden, non-black + ON/OFF-diff pixel gates; also asserts retired `FeatureRendererKey` 29 stays `undefined`. The LUT bake is still alive even though the SKY shader's LUT consumption is gated off (Batch 247) — this probe is the LUT's live regression guard. |
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
| `probe-pp-library-builtins.mjs` | **PostProcessStageLibrary built-ins interception (WIRE-PP-LIBRARY-BUILTINS).** All 7 named library stages (BlackAndWhite, Brightness, NightVision, Silhouette, EdgeDetection, DepthView + a dedicated space-view LensFlare section) added via `PostProcessStageLibrary.create*Stage()` on BOTH backends over a deterministic scene (boxes for depth edges + bright point): each stage visibly transforms the frame on both backends, cross-backend mean-abs-delta within per-stage tolerance, `LibraryPP-*` render-pass labels appear only while a stage is enabled, remove-all returns the WebGPU frame BYTE-IDENTICAL to the default capture, 0 console/GPU errors. LensFlare runs at ~2 earth-radii altitude with the sun ~15° off-axis — closer/overhead cameras degenerate the GLSL isInEarth projection and mask all ghosts on both backends. Run after touching `WebGPULibraryPostProcessStage.ts`, the configure pass's user-stage scan/sync, the stage-removal compaction, or any of the 7 library WGSL twins. |
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
| `verify-model-feature-pick.mjs` / `-pick-webgl-control.mjs` | Picking. **Updated Batch 207**: uses `scene.pickAsync` (the WebGPU-correct async readback) + forces `EllipsoidTerrainProvider` + projects the model center to screen + grid-scans for a hit. Confirms FORK-34 is fixed (b3dm now picks the content `Model`). The remaining residual: WebGPU picks the Model where WebGL returns a `Cesium3DTileFeature` (C-R9-MODEL-FEATURE-PICK). |
| `probe-pick-basic.mjs` | **Minimal pick discriminator (Batch 206/207).** A plain Box `Primitive` + `pickAsync` — the smallest reproduction that the whole WebGPU pick path works. Box → `id:"the-box"` matches WebGL. Use this first when a pick regresses; it isolates the pick infra from any model/feature complexity. |
| `probe-billboard-pick.mjs` | **Billboard pick gate (Batch 248, NEW-DERIVEDCOMMAND-VARIANT-FACTORY).** One billboard, `pickAsync` hit at center + miss control at an empty corner + repeatability + central pipeline-cache name hygiene (a billboard `::pick` variant name exists, NO duplicate descriptor names) + 0 errors. Run after touching `WebGPUDerivedCommand`, the billboard pick path, or pipeline-cache naming. Note: the first-ever pick warms the lazily-created pick pipeline (the probe warms up before asserting — pre-existing Batch 73 behavior). |
| `probe-pickposition-webgpu.mjs` | **pickPosition parity gate (Batch 252, NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION).** Runs BOTH backends at the same nadir view: WebGL reference pick; WebGPU cold-cache contract (frame 0 undefined → Cartesian3 by frame ≤3, never a Promise); cross-backend cartographic match (dLon/dLat ≤0.05°, dH ≤100 m); wheel-zoom-to-cursor smoke (camera descends on target, no NaN/garbage jump — guards the `handleZoom` degenerate-axis fix); 0 errors. Run after touching `PickDepth`, `Picking.pickPositionWorldCoordinates`, `SceneTransforms.drawingBufferToWorldCoordinates`, the log-depth encode, or the SSCC zoom path. **Warmup is `scene.globe.tilesLoaded`-gated + 60 settle frames (Batch 259, FQ-7)** — the fixed-90-frame warmup raced headless tile-depth population (depth read 1.0 everywhere → cold-cache sky-reject → all-undefined → flaky self-fail ~2/3 runs). The readiness gate reads `tilesLoaded` only (does NOT arm the pick readback, preserving the frame-0-undefined cold-cache contract). Reported `warmupFrames`/`tilesLoadedAt`/`tilesLoaded` diagnose any future flake. |
| `probe-pickposition-model-webgpu.mjs` | **pickPosition-over-opaque-Model gate (Batch 257, DP-H45).** Places a large opaque `CesiumMilkTruck` glTF model on the ellipsoid, nadir view from 8 km, warms 200 frames, then asserts WebGPU `pickPosition` at the model center returns the MODEL TOP (h matches WebGL within 30 m), NOT the globe behind/below it. Pre-fix the WebGPU leg returned the globe ~174 km off (dH ≈173887 m). Guards the post-OPAQUE depth re-pack in `WebGPUSceneRendererFrustumLoop.ts` — run after touching that frustum loop's depth-copy/update blocks, `WebGPUGlobeDepth.executeUpdateDepth/executeCopyDepth`, or the per-frustum pick-depth copy. |
| `probe-compute-instance-pickposition.mjs` | **`pickPosition` over a compute-instance gate (NEW-COMPUTE-INSTANCE-PICKPOSITION).** `scene.pickPosition` over a GPU-resident compute-instance returns THAT INSTANCE's world position on BOTH backends. Run after touching `getInstanceWorldPosition`, the `_pickableComputeInstanceFrame` gate in `ComputeInstanceCollection.js`, or the pickPosition compute-instance reconstruction. |
| `probe-sampleheight-webgpu.mjs` | **`sampleHeight`/`clampToHeight` gate (Batch 284, NEW-PICK-RAY-ASYNC; supersedes the FQ-5 Batch-254 honesty-warning assertion).** Asserts both now WORK on WebGPU via main-scene-depth reuse (the Batch-252 pickPosition reconstruction), not just emit a warning. Run after touching the async pick-ray path or the scene-depth reuse plumbing. |
| `probe-pick-ray-async.mjs` | **`sampleHeight`/`clampToHeight`/`pickFromRay` async gate (Batch 284, NEW-PICK-RAY-ASYNC).** WebGPU returns a globe-surface height/position matching WebGL via the main-scene-depth reuse path. The async sibling of `probe-sampleheight-webgpu.mjs`; run after touching the pick-ray reconstruction. |
| `probe-pick-metadata.mjs` | **Metadata/voxel synchronous-readback gate (Batch 285, NEW-PICK-METADATA-READBACK).** The synchronous center-pixel readback used by `scene.pickVoxel` (→ `Picking.pickVoxelCoordinate`) and `scene.pickMetadata` (→ `Picking.pickMetadata`) reads the JUST-RENDERED frame on WebGPU. Run after touching the metadata-pick readback path. |
| `probe-voxel-cell-pick.mjs` | **Per-cell voxel pick parity gate (C-R9-VOXEL-CELL-PICK reland).** Both backends render the 2×4×3 Y_UP staircase asset (probe-voxel-parity Part B's provider) and `Picking.pickVoxelCoordinate` is queried at 4 filled-cell pixels + 2 empty-column pixels + 1 off-box pixel: the 4 readback bytes must match WebGL byte-for-byte (decode to the same `{tileIndex, sampleIndex}` → cell), empty/off-box must be cleared `[0,0,0,0]` on both, and object pick (`pickAsync`) must still return the `VoxelPrimitive`. Run after touching `fragmentPickVoxelMain` / the pickVoxel pipeline in `WebGPUVoxelRenderer.ts`, the `passes.pickVoxel` routing in `selectCommandVariant`, `WebGPUPickFramebuffer.readCenterPixel` (this probe is what caught its vertical-mirror bug — GL bottom-origin rect row used as a top-down texture row), or the voxel shapeUv convention pack. |
| `probe-voxel-octree.mjs` | **Depth-1 voxel octree LOD gate (VOXEL-OCTREE-LOD).** Two-level procedural box provider (`availableLevels: 2`, 4³ per tile, Y_UP): the eight level-1 children form a FINE 8³ thin diagonal, the root is the fat conservative downsample. Close view (root SSE >> `screenSpaceError`): both backends must render the FINE diagonal — 64 analytic per-ray cell expectations, including ≥4 discriminator cells (empty-at-fine / filled-at-root) that a root-only WebGPU render fails as SPURIOUS; WebGPU internals must show `slotCount 9`, all 8 `childSlots` uploaded, `lastTargetLevel 1`. Far view: `lastTargetLevel 0` (root path) + small crop diff vs WebGL. Run after touching `tryUploadChildVoxelTiles`/the atlas allocation (`WebGPUVoxelDataUpload.ts`), the WGSL depth-1 traversal / atlas slab addressing, or `computeVoxelTargetLevel` (`WebGPUVoxelRenderer.ts`). |
| `probe-voxel-user-customshader.mjs` | **User native-WGSL voxel customShader gate (VOXEL-USER-CUSTOMSHADER).** VoxelBox3DTiles with a USER scalar-ramp customShader carrying BOTH `fragmentShaderText` (GLSL, WebGL leg) and `wgslFragmentShaderText` (WGSL, WebGPU leg) authoring the SAME blue↔red ramp over `metadata.a.r`: asserts footprint IoU ≥ 0.85, avg-color L1 ≤ 90 vs WebGL, WebGPU channel spread > 40 (ramp actually replaced the default gray), the WebGPU color pipeline is the `userCustomShader#<hash>` variant, 0 errors. Run after touching `WebGPUVoxelCustomShaderCodegen.ts`, the `VOXEL_USER_CUSTOM_SHADER` nested ifdef in `VOXEL_WGSL`, or `resolveVoxelUserShaderInfo` / the color-module patch seam in `WebGPUVoxelRenderer.ts`. The default-gray + GLSL-only off-gates live in `probe-voxel-parity.mjs` (Part A neutral-gray gate + Part B's GLSL-only customShader). |
| `probe-metadata-multicomponent.mjs` | **VEC2/3/4 property-ATTRIBUTE full-component transport gate (METADATA-MULTICOMPONENT).** Loads `BoxVec3PropertyAttributes` (per-face-constant VEC3 FLOAT32 `_FACE_COLOR`) with `CesiumWebGPUMetadataDebug=true`; the generated `metadataDebugColor` paints the RAW components as RGB — asserts ≥3 authored face colors match on screen (a `.x`-only regression paints dark reds), the generated chunk declares the `vec4<f32>` transport + `metadataValue.xyz` swizzle, and the debug-off scene shows no palette. Run after touching the slot-9 metadata transport (`WebGPUModelMetadata`, `createVertexBufferLayout` slot 9, `MetadataWGSLPipelineStage.constructFromTransport`, or the `MODEL_HAS_METADATA` WGSL blocks). |
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
  const C = await import("/Build/CesiumUnminified/index.js");
  const tracker = new C.PerformanceTracker();
  const v = window.viewer;
  tracker.beginTrace("orbit-snapshot", { frames: 600 });
  for (let i = 0; i < 600; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    // beginPerformanceTrace hooks per-frame collection automatically
  }
  return { csv: tracker.toCSV(tracker.endTrace()), enabled: true };
});
require("fs").writeFileSync(
  "Tools/visual-regression/output/perf-trace.csv",
  trace.csv,
);
```

For GPU timings specifically, `CesiumDebug.gpuPassCost()` returns a structured object; serialize it to JSON the same way.

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

### CPU pass cost (R-7a)

`CesiumDebug.cpuPassCost(true)` enables the per-pass profiler in the WebGPU scene renderer. Pass `false` to disable, no-arg to dump rolling-window stats.

Use cases:

- Decide which passes are worth GPURenderBundle expansion (>5 ms avg = strong candidate; <1 ms = not worth it).
- Catch a regression where a previously-cheap pass starts dominating.

### GPU pass cost

`CesiumDebug.gpuPassCost()` reads from `WebGPUTimestampProfiler` — needs the `timestamp-query` device feature (gated by `WebGPUFeatureFlags`). Some adapters don't expose it; the call returns `{enabled: false}` cleanly.

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

`node Tools/visual-regression/capture-and-diff.mjs` runs every scene in `scenes.json` against the WebGL baseline. See [Tools/visual-regression/README.md](../Tools/visual-regression/README.md) for flags, scene-add procedure, and synthetic-scene `setup` / `setupFile` plumbing.

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
