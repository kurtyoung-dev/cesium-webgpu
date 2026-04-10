# Snapshot Mode Integration Spike — 2026-04-09

> **Phase 0.7 deliverable.** Research-only spike validating how the
> Babylon-style "FAST mode" / locked-orbit snapshot subsystem should
> integrate with `WebGPURenderBundleManager` and the rest of the engine
> before Phase 5/6 commits to bundle-encoded froxel passes.
>
> Outcome: integration approach **green-lit** with the design captured
> below. A registration-skeleton service has been wired (Option B from
> the spike checkpoint) so Phase 1+ features have a stable target.

## 1. Summary

**Recommendation:** Build snapshot mode as a thin coordinator (`SnapshotModeService` under `packages/engine/Source/Services/`) that holds a registry of "freezable" subsystems and orchestrates `freeze()` / `thaw()` calls in lockstep with `Scene._snapshotVersion`. Each freezable owns its actual freeze semantics. The bundle manager's existing `_cache` Map and `beginFrame` eviction loop need only ~30 lines of changes to honor a freeze flag — no new caching infrastructure required.

**Risks identified:** four, all manageable. The largest is detecting "significant" camera motion without thrashing the freeze/thaw loop.

**Effort estimate (after Phase 0):**

| Sub-phase | What | Effort |
|---|---|---|
| **Phase A** | Bundle manager freeze flag + register as freezable | 0.5 day |
| **Phase B** | Camera-delta auto-thaw + threshold tuning | 1 day |
| **Phase C** | VPT lock-on-freeze (already wired in Phase 0.7) + scene event hooks for postUpdate listeners that mutate state | 0.5 day |
| **Phase D** | Validation + tuning on a real static scene | 1 day |
| **Total** | | **3 days** after Phase 0 |

This matches the original NEW-3 estimate (~4-6 days + 1-2 day spike) within tolerance — the spike compressed scope by reusing the existing bundle cache instead of building parallel infrastructure.

## 2. What snapshot mode actually does

Cesium's per-frame CPU profile for a static scene (camera locked, no tile loads, no entity updates) is dominated by **command encoding** — walking the scene graph, building draw commands, validating GPU state, recording into render passes. On a typical Cesium frame this is 30-60% of the CPU budget. Babylon, Filament, and PlayCanvas all ship a "snapshot" / "FAST mode" optimization that records the encoded command stream once and replays it for subsequent identical frames, yielding 2-5x speedup until something visible changes.

For Cesium-WebGPU, this maps cleanly onto **render bundles**: the WebGPU API has first-class support for pre-encoding draw commands into a `GPURenderBundle` that can be replayed via `renderPass.executeBundles([...])` with near-zero CPU cost. Our `WebGPURenderBundleManager` already encodes static terrain bundles per-tile (`packages/engine/Source/Renderer/WebGPU/WebGPURenderBundleManager.ts:1`) — snapshot mode just keeps those bundles cached longer than the normal eviction policy would allow.

For the WebGL backend there are no render bundles, but snapshot mode is still useful as a "lock VPT tuning" surface — the auto-tuner's quality dial outputs cause visible frame-to-frame popping if they keep moving while the user is presenting, so freezing them on snapshot entry is a meaningful improvement.

## 3. Integration architecture

### 3.1 The freezable contract

```js
{
  name: "webgpu-bundle-manager",
  freeze() { /* mark cache as snapshot-locked */ },
  thaw()   { /* return to normal eviction */ },
  isFrozen() { /* introspection */ }
}
```

The service owns no domain knowledge — every subsystem that needs to participate registers itself. This mirrors how the Phase 0.4 VPT service handles probes and sinks.

### 3.2 Reconciliation contract with `Scene._snapshotVersion`

Phase 0.5 wired `Scene._snapshotVersion = 0;` and bumps it from `Cesium3DTilesInvalidationFeed.apply()`. The snapshot service captures the current value as a baseline when entering snapshot mode, and on every `tick()` compares the live value against the baseline. Any divergence triggers an auto-thaw with the reason logged in the diagnostics. This is the cheap path — no per-frame walk of registered freezables, no event listeners, just one integer compare.

```text
T=100  enter()                  baseline=42, freeze() called on all freezables
T=101  tick()  scene._snapVer=42  no-op
T=102  tick()  scene._snapVer=42  no-op
T=103  invalidation feed bumps to 43
T=103  tick()  scene._snapVer=43  AUTO-THAW (baseline 42 -> 43)
```

### 3.3 Camera-delta auto-thaw (Phase B, deferred from spike)

Snapshot mode must also thaw when the camera moves meaningfully. Naive implementations thrash on millimeter jitter because every input event nudges the camera by a few microns. The recommended approach is a simple distance-and-rotation epsilon test in the existing `checkForCameraUpdates()` path (`Scene.js` ~line 2766) — if the magnitude of the position delta exceeds `cameraDeltaThreshold` OR the rotation delta exceeds `cameraRotationThreshold`, mark the snapshot dirty.

**Threshold tuning** is the open question — too tight and a sensitive trackball thrashes, too loose and visible parallax during a "locked" tour breaks the illusion. Default proposal: `1e-3` of the bounding sphere diagonal for position, `0.5°` for rotation. Tune in Phase B against a real scene.

### 3.4 Bundle manager freeze flag (Phase A)

The current `WebGPURenderBundleManager.beginFrame()` (`WebGPURenderBundleManager.ts:168`) increments a frame counter and runs `_evictStale()` every 60 frames. The freeze flag adds two checks:

```ts
beginFrame(): void {
  this._currentFrame++;
  if (this._isFrozen) return;            // <-- skip eviction entirely
  if (this._currentFrame % 60 === 0) {
    this._evictStale();
  }
}
```

And `getOrCreate()` should refuse to admit new bundles to the cache while frozen — instead it should fall through to the underlying record-and-discard path so transient one-frame additions don't pollute the snapshot:

```ts
getOrCreate(...) {
  const existing = this._cache.get(key);
  if (existing) {
    existing.lastUsedFrame = this._currentFrame;
    return existing.bundle;
  }
  if (this._isFrozen) {
    // Build the bundle but DON'T cache it — the snapshot is sealed.
    return this._buildEphemeral(key, descriptor, recordCallback);
  }
  return this._createBundle(key, descriptor, recordCallback);
}
```

This is ~30 lines of changes total. A `freeze()` / `thaw()` pair on the manager just toggles `this._isFrozen`. The manager registers itself with `scene.snapshotMode` once at construction.

### 3.5 VPT integration (already wired in Phase 0.7)

Each tick after `snapshotMode.tick(scene)`, Scene forwards the freeze state to VPT via `vpt.snapshotMode = snapshotMode.isFrozen`. This satisfies the VPT contract guard from Phase 0.4 (VPT.tick() must no-op while in snapshot mode). Already shipping.

### 3.6 Late-arrival registration

If a freezable registers AFTER snapshot mode has been entered (e.g. a tileset added at runtime while paused), it joins the active snapshot immediately — `registerFreezable()` calls `freeze()` on the new arrival before returning. This is implemented in the Phase 0.7 skeleton.

## 4. Risks identified

### 4.1 Camera-delta threshold thrashing
**Severity: medium.** Detailed in §3.3. Mitigation is straightforward: hysteresis (require N consecutive tight frames to refreeze after a thaw) and per-scene tuning. Carry as a Phase B tuning task, not a blocker.

### 4.2 Scene event listeners that mutate state silently
**Severity: medium.** Cesium has multiple `postUpdate` / `preRender` event hooks that user code can subscribe to. A user listener that mutates an entity property does NOT bump `_snapshotVersion`, so the snapshot becomes visually stale without auto-thawing. **Mitigation:** add a Scene-level helper `scene.markSnapshotDirty(reason)` that user code can call from listeners; document the contract in the snapshot service JSDoc; add a verbose debug-only mode that scans entity dirty flags after each render and warns if any drifted while frozen. Carry as a Phase C deliverable.

### 4.3 Bundle manager `_evictStale` grace period after thaw
**Severity: low.** When a snapshot thaws after holding bundles for 5+ minutes, every cached bundle has a stale `lastUsedFrame` from before the freeze. The next `beginFrame` cycle would evict everything immediately, defeating the purpose of having held them. **Mitigation:** on thaw, walk the cache once and reset every `lastUsedFrame` to the current frame number. Trivial, ~5 lines, add to Phase A.

### 4.4 WebGPU swap-chain texture format changes during snapshot
**Severity: low.** If the user resizes the window or changes HDR mode while a snapshot is held, the existing bundles target a swap-chain configuration that no longer exists. WebGPU will throw on `executeBundles`. **Mitigation:** the Scene already has `_logDepthBufferDirty` and `_hdrDirty` flags that bump `_renderRequested` — wire them to also `markSnapshotDirty()` so the snapshot auto-thaws on configuration change. Trivial, add to Phase C.

## 5. Things deliberately NOT in scope for snapshot mode

- **Animation playback during snapshots.** A snapshot is by definition static. Animated entities should auto-thaw on their first tick (handled via `markSnapshotDirty` from the animation system in a future PR — not Phase 0.7).
- **Multi-scene snapshots.** Each Scene has its own SnapshotModeService instance. Multi-context apps (split-screen, multi-view) get one snapshot per scene, no cross-coordination.
- **Persistence across sessions.** Snapshots are in-memory only. No serialization to disk; no resume across browser reloads. Out of scope.
- **GPU memory pressure handling.** The bundle manager's normal `_maxCacheSize` eviction is suspended while frozen. If a snapshot is held while the user navigates somewhere expensive, the cache can grow unboundedly. **Future enhancement:** soft cap (warn) and hard cap (force-thaw on OOM warning) — defer to the Phase D validation pass which will measure real numbers.

## 6. Open questions

| ID | Question | Default if undecided |
|---|---|---|
| OQ1 | Camera delta threshold default values | `1e-3` × bounding-sphere diagonal for position, `0.5°` for rotation |
| OQ2 | Should `markSnapshotDirty()` be on `Scene` or on `SnapshotModeService`? | Scene, mirrors `requestRender()` |
| OQ3 | Should snapshot mode be exposed via `scene.snapshotMode.enabled = true` only, or also via a viewer-level shortcut? | Service-level only for now; Viewer wiring later |
| OQ4 | What happens to in-flight tile loads when snapshot is entered? | Allow them to finish; their content arrives after thaw; do not interfere |
| OQ5 | Does snapshot mode interact with `requestRenderMode = true`? | Yes — request render mode is already an "only render on demand" mode; snapshot mode is "render but skip encoding". They compose: a frame happens iff request render mode says it should AND snapshot mode says nothing has changed, the frame replays the bundles instead of rebuilding. Worth a one-line test in Phase D. |

## 7. Phase 0.7 deliverable: skeleton wired

The Phase 0.7 work has shipped:

- **NEW** `packages/engine/Source/Services/SnapshotModeService.js` — registration skeleton with `enter`/`exit`/`tick`/`registerFreezable`/`unregisterFreezable`/`getStatistics`. ~290 LOC. Reconciliation against `scene._snapshotVersion` already implemented. Camera-delta detection deferred to Phase B.
- **MODIFIED** `packages/engine/Source/Scene/Scene.js` — instantiate `_snapshotMode` in constructor next to `_visualPerformanceTarget`, expose public getter `scene.snapshotMode`, call `_snapshotMode.tick(this)` inside the `if (shouldRender)` block, forward snapshot state to VPT each frame.
- **VALIDATION** — `npx tsc --noEmit` clean.

No bundle manager changes yet — that's Phase A. The skeleton means Phase 1+ features can start writing `scene.snapshotMode.registerFreezable("my-cache", { freeze, thaw })` immediately and have it work the moment Phase A lands.

## 8. Status & next steps

**Spike complete.** Recommendation: green-lit. The skeleton is in place. The Phase 1 (celestial) and Phase 2 (volumetric fog/clouds) work can register freezable bundle caches against the service as they're built — no further plumbing required from those features.

**Implementation phases queued (separate PRs):**

| Phase | What | When |
|---|---|---|
| **Phase A** | Bundle manager freeze flag + self-registration | After Phase 1 lands (so there are real terrain bundles to freeze) |
| **Phase B** | Camera-delta auto-thaw + threshold tuning | Same PR as Phase A |
| **Phase C** | `markSnapshotDirty()` + event listener mutation guard + HDR/depth buffer interaction | After Phase A/B in production for ~1 week |
| **Phase D** | Validation on a real static scene + tuning + GPU memory pressure handling | Final polish, before release |

**Cross-references:**

- `SESSION_2026-04-08_RESEARCH_REPORT.md §10 NEW-3` — original research backlog item, this spike satisfies it
- `SESSION_2026-04-08_RESEARCH_REPORT.md §10 NEW-8` — `_snapshotVersion` hook, already wired in Phase 0.5
- `CELESTIAL_ATMOSPHERE_DESIGN.md §11` — VisualPerformanceTargetService, already wired in Phase 0.4
- `packages/engine/Source/Renderer/WebGPU/WebGPURenderBundleManager.ts:1` — the freezable that will register first
- `packages/engine/Source/Services/SnapshotModeService.js` — Phase 0.7 skeleton
- `packages/engine/Source/Services/VisualPerformanceTargetService.js` — Phase 0.4 skeleton
