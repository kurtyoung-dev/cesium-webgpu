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

90+ scripts. Use this table to find an existing probe before writing a new one — most "I need to test X" cases have a template.

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
| `probe-collections-far-camera.mjs` | **The far-camera log-depth gate (Batch 251, NEW-COLLECTIONS-LOG-DEPTH).** Billboards + points 1000 m above a VISIBLE solid-color globe at a 220 km camera WITHOUT disableDepthTestDistance — the original "bug 2" depth-tie case that was impossible pre-log-depth. Asserts: markers render with log depth ON; a below-ground negative control stays occluded (depth test intact); a runtime kill-switch leg (`context._logDepthWriteEnabled = false`) reproduces the historical vanish then flips back green (exercises every renderer's flip-rebuild guard); reports ON/OFF avg frame cost; 0 console errors. Run after ANY change to depth encoding, the LOG_DEPTH define plumbing, or a new depth-writing pipeline family. Writes `output/collections-far-camera-{on,off}.png`. Known flake (Batch 253 sweep): when run deep inside an uninterrupted multi-probe sequence, the below-ground control + kill-switch legs can read pre-settle globe tiles (red>0 AND no hyperbolic vanish together = the tell) — re-run standalone before suspecting a regression. |
| `probe-billboard-partial-write.mjs` | **Regression guard for the Batch 229 resident-instance manager + billboard wiring** (NEW-RESIDENT-INSTANCE-BUFFER-MGR / NEW-PARTIAL-WRITE-WIRE-BPL): 1000 settled billboards → 0 uploads over 30 frames; 1 moved → exactly 1 partial write of 1×176 B stride, renders at the new position. Reads the manager's debug-pragma counters (`_fullRebuilds`/`_partialWrites`/`_bytesUploaded`). Header documents the depth-precision envelope (camera ≤ ~10 km — see NEW-COLLECTIONS-LOG-DEPTH). |
| `probe-resident-instance-prev-mirror.mjs` | Manager `mirrorPrev` (velocity prev-buffer) write contract via intercepted writes (Batch 229). The live TAA consumer went live in Batch 234 — see `probe-taa-velocity-emission.mjs`. |
| `probe-taa-velocity-emission.mjs` | **Regression guard for the Batch 234 canonical `frameState.taaEnabled` publication** (NEW-COLLECTIONS-TAA-GATE-DORMANT): TAA OFF→ON→OFF with moving billboards + points. OFF → no `velocityCommand`, velocity texture unallocated, msaa=4; ON 60 frames → velocityCommand attached on billboard + point color commands with the slot-aligned prev buffer as the 2nd vertex stream, velocity texture allocated, msaa forced to 1 (TAA↔MSAA contract), 0 console/validation errors; OFF → commands detach, msaa restored. |
| `probe-point-label-partial-write.mjs` | **Regression guard for the Batch 232 point + label manager wirings** (NEW-PARTIAL-WRITE-WIRE-BPL remainder): 1000 points + 200 labels settled → 0 uploads on both managers; 1 moved point → exactly 1 partial write of 1×112 B; 1 label text change → full rebuilds only (never partial — glyph granularity is unsound for per-slot writes) with the new text rendered; cross-collection isolation (label edit doesn't touch the point manager). |
| `probe-orbital-catalog.mjs` | **Regression gate for the compute-instance system** (Batch 230/231) driving the orbital demo kernel: 2000 GPU-resident instances render + move with CPU uploading only a time scalar. |
| `probe-compute-instance-generic.mjs` | Feature-agnosticism proof for the compute-instance system (Batch 231): NON-orbital rotating-Lissajous kernel renders + moves. Run together with `probe-orbital-catalog.mjs` after any change near `ComputeInstanceCollection` / `WebGPUComputeInstanceRenderer`. |
| `probe-pickmodel-instanced.mjs` | **CPU `pickModel` on instanced models, BOTH backends (Batch 238 upstream #13433 port; WebGPU section REQUIRED since Batch 245, NEW-WEBGPU-INSTANCED-VA-DIVISORS).** [0] Node-level `ModelReader.octDecode` round-trip (no build needed); [1] WebGL BoxInstanced matrix-path: CPU pick hits every rasterized interior pixel + `pickPosition` distance cross-check + empty-center miss; [2] WebGPU: matrix-path AND translation-only instancing render (lit-pixel parity vs WebGL), CPU picks hit all 4 instances at exact +X faces, miss control, 0 errors. Run after touching ModelReader, InstancingPipelineStage, WebGPUModelInstancing, or the VA divisor plumbing. Deterministic lighting: fixed -X headlight, not wall-clock SunLight. |
| `probe-model-pbr-audit.mjs` | **Broad Model PBR asset audit (Batch 141).** Loads CesiumMan (skinned+animated), CesiumMilkTruck (multi-primitive textured PBR), GroundVehicle (KHR_materials_unlit), BoxInstanced (GPU instancing); per asset asserts 0 device errors during render and reports material-UB sizing + passes invoked. Run after WGSL changes to `ModelPBRComplete.wgsl`, the model pipeline cache, or material UB packing (5/5 assets green as of Batch 245). |

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

### Environment / sky / sun / atmosphere

| Probe | What it covers |
| --- | --- |
| `probe-ground-view-env.mjs` | **Regression gate for the three ground-level environment divergences (Batch 247, NEW-GROUND-VIEW-ENV-DIVERGENCES), webgl-vs-webgpu same-scene numeric.** (1) ground-sky brightness — mean-luminance + HSB-value ratio over the top sky band, band [0.8, 1.25] (post-fix 0.99x/0.99x; pre-fix 1.73x/1.46x — caught the over-converged quadrature + non-WebGL shell geometry + LUT azimuth bug); (2) sun disk at a sun-aimed ground view — bright-pixel count within 180 px of frame center, atmosphere ON must keep the disk (caught the binned-sun-under-injected-skyAtmosphere ordering bug) with an atmosphere-OFF control; (3) no-imagery globe baseColor — exact pixel vs `globe.baseColor` rgb(31,38,51) (caught the hardcoded WGSL base). Writes `output/ground-view-env/{basecolor,sky,sun-atmo-on,sun-atmo-off}.png` per backend. Run after any change near SkyAtmosphere, Sun, the env-command injection (SceneRenderer.js), or the globe first-pass base color. |
| `probe-ground-atmosphere.mjs` | Globe ground-atmosphere drape (the inscatter-LUT FOG-drape consumer): groundAtmosphere ON vs OFF with skyAtmosphere hidden, non-black + ON/OFF-diff pixel gates; also asserts retired `FeatureRendererKey` 29 stays `undefined`. The LUT bake is still alive even though the SKY shader's LUT consumption is gated off (Batch 247) — this probe is the LUT's live regression guard. |

### Post-process / effects

| Probe | What it covers |
| --- | --- |
| `probe-bloom-parity.mjs` | **Bloom uniform parity gate (Batch 240, NEW-BLOOM-UNIFORM-PARITY), webgl-vs-webgpu.** Default-uniform bloomed-pixel fraction ratio band [0.2x, 2x], glowOnly + brightness uniform response, 0 errors. Scene strips all backend-divergent env elements (sky/sun/skybox/imagery/water) — the ground-view divergences it documented are now fixed under NEW-GROUND-VIEW-ENV-DIVERGENCES (Batch 247). |
| `probe-taa-resolve.mjs` | **Regression gate for the Batch 244 TAA resolve activation** (NEW-TAA-EFFECT-NEVER-ADDED): TAA OFF→ON→OFF. OFF → no `_taaEffect`, msaa=4, baseline renders; ON → effect lazy-added + enabled, the resolve pass ENCODES (debug-pragma `resolveCount` strictly increases), velocity attaches, msaa=1, 60 moving frames 0 errors, settled scene temporally STABLE (consecutive-frame diff < 1%) and NOT smeared (camera rotation below the teleport threshold → image follows within one frame, billboard pixel count doesn't ghost-double); OFF → bypass (instance kept, `enabled=false`, `resolveCount` frozen), velocity detaches, msaa restored. Run after any change near the TAA effect, the post-process configure pass, or the TAA↔MSAA coupling. |
| `diag-taa-black.mjs` | One-off device-`pushErrorScope` diagnostic that found the Batch 244 latent failures (depth+filtering sampler pipeline rejection; G-buffer MSAA mismatch killing the scene pass). Template for "pass runs but output black with 0 console errors" investigations — uncaptured validation errors don't always reach the console; an explicit error scope catches them. |
| `probe-bloom-no-globe.mjs` / `-no-msaa.mjs` / `-no-pp.mjs` / `-no-sky.mjs` / `-side-by-side.mjs` / `-tile-state.mjs` | Bloom bisection variants |
| `probe-msaa-comparison.mjs` | MSAA on vs off |
| `probe-tonemap.mjs` / `-gamma-chain.mjs` | Tonemap + gamma chain |
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
| `probe-pickposition-webgpu.mjs` | **pickPosition parity gate (Batch 252, NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION).** Runs BOTH backends at the same nadir view: WebGL reference pick; WebGPU cold-cache contract (frame 0 undefined → Cartesian3 by frame ≤3, never a Promise); cross-backend cartographic match (dLon/dLat ≤0.05°, dH ≤100 m); wheel-zoom-to-cursor smoke (camera descends on target, no NaN/garbage jump — guards the `handleZoom` degenerate-axis fix); 0 errors. Run after touching `PickDepth`, `Picking.pickPositionWorldCoordinates`, `SceneTransforms.drawingBufferToWorldCoordinates`, the log-depth encode, or the SSCC zoom path. |
| `verify-vector-3dtile-frs.mjs` | Vector 3D Tiles feature renderer (FR registration + device-error smoke only — does NOT render real Vector3DTile content; see the Vector3DTile verification-gap note above). |
| `probe-error-gate-selftest.mjs` | **Self-test for the WebGPU error/crash gate** (`Tools/lib/webgpu-error-gate.mjs`). Proves the gate catches an injected uncaptured validation error, stays clean on valid work, and ignores `device.destroy()` teardown. Run after touching the gate or either harness's gate wiring. |

### Cross-backend / Sandcastle

| Script | What it does |
| --- | --- |
| `sandcastle-smoke.mjs` | **LOCAL-REQUIRED Sandcastle WebGPU gate (Batch 242).** Loads 3 renderer-pinned WebGPU gallery demos at their standalone URLs (Orbital Catalog → globe + depth plane + compute-instance; Clustered Lighting → glTF + clustered lights, globe off; Point Light Shadows → entities + glTF + cube shadows) and asserts per demo: non-black pixel fraction ≥ ~half the healthy baseline (15.8% / 79.7% / 100% measured 2026-06-12), ≥8 distinct sampled colors, ≥1 WebGPU device created (silent WebGL fallback = FAIL), 0 console/validation/device-loss errors (auto-arms the error gate by patching `GPUAdapter.requestDevice` — Sandcastle demos expose no `window.viewer`). Exists because the DepthPlane MRT bug blanked EVERY Sandcastle demo for ~115 batches while all CesiumViewer-driven probes stayed green. **Cannot run in CI** (no WebGPU adapter on hosted runners) — run it locally before committing anything touching scene-FB passes, the post-process blit chain, MRT attachment states, or the Sandcastle bootstrap. Captures land in `output/sandcastle-smoke/*.png`. |
| `cross-backend-sandcastle-runner.mjs` | Runs Sandcastle demos on both backends, diffs results |
| `sandcastle-batch-66-runner.mjs` / `-final-runner.mjs` / `-end-of-session-runner.mjs` | Batch-specific Sandcastle runners |
| `analyze-cross-backend-report.mjs` | Post-process the cross-backend report |

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
