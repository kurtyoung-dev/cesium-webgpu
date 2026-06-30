# C2-25 — Dynamic Scene-Content Environment Map: Scene-Capture Design

**Status:** Batch 446 = globe slice (in progress). 447 = 3D Tiles, 448 = glTF follow.
**Decision (2026-06-29):** user chose **full geometry capture** (globe + 3D Tiles + glTF),
delivered as parity-verified increments. Sky env map is already shipped (Batch 346 + 430:
`ProceduralSkyCubemap.wgsl` is a 1:1 port of the visible-sky atmosphere + shares the
sun-relative sky-view / MS LUTs), so this epic is purely about reflecting **geometry**.

Derived from the `c2-25-3a-globe-capture-design` workflow (survey → 2 candidate designs →
judge). Approach **B** (generalize the CSM override-camera pass to color) with grafts from A.

---

## Already-wired scaffolding (reuse, do NOT rebuild — Principle 7)

- `cache.faceViews[6]` — 6 per-face `dimension:'2d'` render-capable views
  (`WebGPUDynamicEnvironmentMapManager.ts:270-281`). Allocated-noop today (nothing reads them).
- Cube texture usage already carries `STORAGE_BINDING | RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST`
  (`:248-252`) — `faceViews` are already legal color attachments; zero usage change.
- `runProceduralSkyFill` (`:745-751`) dispatches **linear** sky radiance into `cache.storageView`
  (the `2d-array` view of the SAME cube). Keep it as the sole sky/background writer.
- The IBL tail is **source-agnostic** and fully wired: `runIBLPrefilter → generateIBLMaps`
  (`:360`), `runSphericalHarmonicProjection → ProjectRadianceToSH` (`:364`),
  `_webgpuIBLDiffuseView/_webgpuIBLSpecularView/_webgpuSHBuffer` publication (`:379-392`),
  `buildModelIBLEntries` (`WebGPUModelRenderer.js`, bindings 33/34/35/36). All consume
  `cache.cubemapTextureView` regardless of origin. **Capture changes only the cube SOURCE.**

## Override-camera mechanism

- **Seam:** `context.uniformState.updateCamera(faceCamera)` (`UniformState.js:742`) — the same
  seam the WebGL shadow loop uses to repoint all geometry. The globe color camera-UB packer
  `createCameraUniformBuffer` (`WebGPUGlobeSurfaceCameraUB.ts:92`) reads view/proj/
  mvpRelativeToEye/encodedCameraHigh-Low **exclusively** from `uniformState` (never
  `frameState.camera` — verified). So swap `uniformState`'s camera, re-run the tile-command
  builder per tile, and the face-camera RTE matrices fall out correctly.
- **Precedent:** `WebGPUCSMCastPass.renderCSMCastPass` already packs an RTE override camera
  from an override `cameraPositionWC`, opens its own render pass with its own depth target,
  and iterates the main-camera-selected globe cast commands.
- **Timing:** `primitives.update` (env FR) fires BEFORE `globe.render` (`ViewportExecutor.js:80`
  vs `:93`), so current-frame globe commands don't exist yet — capture builds its OWN per-face
  commands.

## The one mandatory net-new GPU artifact: single-target capture pipeline

The on-screen globe fragment returns a 2-location `FragOutput { @location(0) color,
@location(1) normalRoughness }` (`GlobeTerrain.wgsl:2688-2738`) and the on-screen pipeline emits
2 MRT targets + `depth24plus-stencil8` + optional MSAA (`WebGPUGlobeSurfacePipelines.ts:417-455`).
A capture pass into a SINGLE `faceView` (no slot-1, no MSAA, `depth24plus` no-stencil) would be a
WebGPU validation error. So:

- **`CAPTURE_MODE` ShaderDefine bit (next free, `1<<4`, ADD-ONLY)** — selects a
  `FragOutputCapture { @location(0) color }` variant via `//>>ifdef CAPTURE_MODE` / `//>>else`
  / `//>>endif`. The `//>>else` branch MUST be byte-for-byte today's shader so `defines=0`
  output is unchanged → the on-screen module hash is unchanged → no on-screen rebuild.
- **Single-target capture pipeline branch** in `buildPipelineDescriptor` (or a sibling):
  `targets=[{format: faceFormat}]`, `depthStencil.format='depth24plus'`, `multisample=undefined`.
- **Separate `_capturePipelineCache`** keyed on `faceFormat + captureDepthFormat + sampleCount=1
  + CAPTURE_MODE`, NEVER touching `_canvasFormat / _sampleCount / _pipelineCache /
  _scenePipelineFormatGeneration` (the on-screen `createTileCommands` runs an inline
  `_pipelineCache.clear()` wipe keyed on that generation at `WebGPUGlobeSurfaceRenderer.ts:646`;
  the capture variant must not bump it or the next on-screen frame rebuilds every globe pipeline).

## Face cameras + depth + sky

- **Face basis:** `CAPTURE_FACE_BASIS` const REMAPPED from `ShadowMapComputations.js:592-617`
  (WebGL order `-X,-Y,-Z,+X,+Y,+Z`) to the WebGPU `faceViews` array-layer order
  (`+X,-X,+Y,-Y,+Z,-Z`) so `face index == faceViews[i].baseArrayLayer`. **Highest correctness
  risk** — verify per-face placement with a colored-landmark ON probe, not just a diff drop.
- **Face camera:** `ShadowMapCamera`-shaped (viewMatrix/inverseViewMatrix/positionWC/directionWC/
  upWC/rightWC/positionCartographic/frustum), eye = `manager._position` (the reflective owner's
  bounding-sphere center, NOT the scene camera), `PerspectiveFrustum` fov=π/2 aspect=1.
- **Depth:** ONE transient `cache.size×cache.size` (256) depth texture
  (`captureDepthTexture/View`), lazy (OFF allocates nothing), reused across 6 faces,
  `depthLoadOp='clear' clearValue=1.0`, `depthStoreOp='discard'`. Format `depth24plus` (no
  stencil) — deliberately different from on-screen, which is WHY the capture pipeline variant
  is mandatory.
- **Sky background:** keep `runProceduralSkyFill` (compute → `storageView`); each capture face
  pass opens on `faceViews[face]` (a `2d` view of the SAME cube) with `loadOp='load'` so the
  compute sky is preserved and globe composites OVER it. Globe writes LINEAR (no tonemap reached
  here) → consistent linear cube for the IBL/SH tail.

## Parity gating (default-OFF byte-identical)

`wantCapture = frameState.context.sceneCaptureReflections === true &&
manager.enableSceneCapture === true && frameState.mode === SCENE3D` (mirror the
`envMapMultiScatter` flag-read at `:339-342`). OFF invariants, each independently sufficient:
1. `runSceneCapture` never entered → no new encoder/beginRenderPass/submit.
2. `runProceduralSkyFill` stays sole face writer → cube byte-identical.
3. No `uniformState.updateCamera` → globe camera UB + main passes bit-for-bit unchanged;
   `_logDepthEncodeNearFar` / `previousViewProjection` never perturbed.
4. Capture depth + capture pipeline variant lazily allocated INSIDE `runSceneCapture` → OFF
   allocates nothing.
5. `CAPTURE_MODE` add-only; `defines=0` emits the `//>>else` branch byte-identical to today →
   on-screen module hash unchanged.

**Restore invariant (load-bearing):** snapshot main camera before face 0; restore via
`uniformState.updateCamera(mainCamera)` in a **finally** after face 5, before any later frame
stage reads `uniformState`. Covers the DP-H41 `previousViewProjection` tail AND the
`_logDepthEncodeNearFar` stash (`WebGPUGlobeSurfaceCameraUB.ts:807-816`). Any throw between
face 0 and restore leaks the face camera into the main scene's depth-classify decode + motion
vectors → try/finally mandatory.

**Debounce (caps ON cost; behind the flag so OFF gate value is byte-identical):** extend the
`:358` gate with a capture camera-translation threshold (`cache.lastCaptureCameraWC` > N km) +
every-K-frames (`cache.framesSinceCapture`).

## Tile-set fidelity (V1 limitation, deferred)

Reuse the main-camera-selected visible tile set (CSM precedent). Faces pointing away from the
main view get coarse/absent tiles; back faces may show only sky. **Acceptable for V1** —
per-face quadtree re-selection (6× `GlobeSurfaceTileProvider` with override frustums) is a much
larger effort, explicitly DEFERRED. Document the away-side coarseness so it isn't later filed as
a bug.

## Probe plan (Principle 8)

- **`probe-scene-capture-off.mjs`** (load-bearing, run FIRST): both flags false (default).
  Assert canvas diff vs the pre-446 build ~0% (<0.05%), submitted GPU pass/command count
  identical, globe camera UB bytes identical. Proves byte-identical-off.
- **`probe-scene-capture-on.mjs`**: reflective PBR model (high metalness, low roughness) on
  visible terrain; assert terrain color appears in the reflection where only sky showed. **Face-
  mapping check:** distinctly-colored landmark on ONE side of `manager._position` lands on the
  CORRECT cube face (catches the basis-order remap bug). Read PNGs; confirm no limb-tile tearing
  (RTE far-camera precision around the ellipsoid-surface eye).

## Ordered steps (Batch 446)

1. [low] Public opt-in flags (default false): `DynamicEnvironmentMapManager.enableSceneCapture`
   + `contextOptions.webgpu.sceneCaptureReflections` getter on `WebGPUContext`.
2. [low] Add `CAPTURE_MODE` ShaderDefine bit (`1<<4`, add-only) — JSDoc, no reorder.
3. [medium] `//>>ifdef CAPTURE_MODE` block in `GlobeTerrain.wgsl` (single-location FragOutput);
   `//>>else` = byte-for-byte today.
4. [medium] Single-target capture pipeline branch in `WebGPUGlobeSurfacePipelines.ts`.
5. [high] `WebGPUGlobeSurfaceRenderer.getOrCreateCaptureTileCommands` — capture sibling routing
   through a SEPARATE `_capturePipelineCache`; no `_scenePipelineFormatGeneration` wipe.
6. [low] `cache.captureDepthTexture/View` (lazy) + `framesSinceCapture` + `lastCaptureCameraWC`.
7. [high] `buildCubeFaceCamera(out, eyeWC, face, near, far)` — ENU 90° face camera, REMAPPED
   basis order.
8. [high] `runSceneCapture(device, cache, manager, frameState)` — double-flag+SCENE3D+debounce
   gate; snapshot camera; 6-face loop (build face cam → updateCamera → iterate visible tiles via
   getOrCreateCaptureTileCommands → beginRenderPass on faceViews[face] loadOp='load' +
   captureDepthView → replay descriptors → end); finally restore main camera. Own encoder+submit.
9. [medium] Wire call site: inside the `:358` refresh block, after `runProceduralSkyFill`, before
   `runIBLPrefilter`. Extend gate with capture debounce behind the flags.
10. [medium] Two Playwright probes (OFF first, then ON). Read PNGs.
11. [low] Docs: `FEATURE_INVENTORY.md` §B, `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md:271`,
    `WEBGPU_DEBUGGING_LOG.md`, `DEFERRED_WORK.md` (face-order remap + deferred per-face
    re-selection).

## Open risks (carry into 447/448)

- **Face-order basis remap** — top correctness bug; mirrored/rotated reflections look plausible.
- **Mandatory shader variant** — `//>>else` must be byte-identical or the on-screen hash shifts.
- **Restore invariant** — spans `_logDepthEncodeNearFar` + `previousViewProjection`; try/finally.
- **Separate `_capturePipelineCache`** — must not bump `_scenePipelineFormatGeneration`.
- **RTE far-camera precision** — ellipsoid-surface eye + 90° frustum stresses limb tiles.
- **Uniform-ring pressure** — 6×N UB writes per capture frame; preserve the BUG-9 beginFrame
  touch in the capture sibling.
- **OFF byte-identity must be PROVEN by probe**, not assumed.
