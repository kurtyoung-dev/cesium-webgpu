# Plan — 2D / Columbus-View / Morph Parity Batches (WebGPU)

Produced by the `plan-2dcv-morph-batches` workflow (2026-06-07), then extended.
Theme: finish 2D / COLUMBUS_VIEW / MORPHING parity on the WebGPU renderer.

Already fixed (do NOT re-scope): BUG-3 SCENE2D blank (Batch 215); morph globe
terrain splay + ground-polyline morphTime freeze (Batch 216).

Source of candidates: `DEFERRED_WORK.md` "Scene-mode morph pillar" + "Morph
review gaps" + `FEATURE_INVENTORY.md` 2D/CV classifier WIP.

> **Scoping status:** 4 of 11 candidates were deeply scoped by the workflow (the
> other 7 hit a transient server rate-limit). The 4 scoped became Batches 1–3
> below; the remaining 7 are in **§Backlog — pending scoping**. Batch 1 is fully
> specified and independent, so execution starts there.

---

## BATCH 1 — Globe morph endpoint stability + Web Mercator detection (two P2 quick wins) ✅ DONE (Batch 217)
- **Item IDs**: MORPH-MIX-JITTER, MORPH-WEBMERCATOR-INSTANCEOF
- **Severity / effort**: P2 + P2 / S
- **Scope**: (1) `GlobeTerrain.wgsl:1111` blends morph positions with the WGSL builtin `mix()`, which on NVIDIA 3070 Ti / Intel Arc A750 doesn't return exactly the endpoint at t=0/t=1 → vertex shimmer on a settled/near-settled globe. WebGL avoids it with a manual lerp (`columbusViewMorph.glsl:17`). Replace with `vec4<f32>(position2DWC.xyz*(1.0-morphTime)+position3DWC4.xyz*morphTime, 1.0)` + a WHY comment; `v_positionEC` (line 1113) derives from the same `morphPos` so it's fixed automatically. (2) `WebGPUGlobeSurfaceCameraUB.ts:438-442` detects Web Mercator via `projection.constructor.name === "WebMercatorProjection"`, which esbuild `minifyIdentifiers` renames in release builds → `useWebMercator` flips to 0 → latitude/texture warping in minified 2D/CV/morph. Import `WebMercatorProjection` and use `instanceof` (matching WebGL `GlobeSurfaceTileProviderRendering.js:1201`). Do NOT add `keepNames`.
- **Files**: `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`, `Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts`, then `DEFERRED_WORK.md` + `WEBGPU_DEBUGGING_LOG.md`. Do NOT hand-edit `Source/Shaders/WebGPU/.../GlobeTerrain.js` (build output). Leave `csm_columbusViewMorph.wgsl` in place (scaffolding, Principle 7).
- **Verification**: `probe-2dcv-verify.mjs` (settled 2D + CV) + `probe-morph-midframe.mjs` (t≈0.5) for no-regression (the fixes are no-ops on textbook-`mix` dev hardware; endpoint correctness is exact by algebra). WebMercator: build a viewer with `mapProjection: new WebMercatorProjection()`, READ the PNGs vs WebGL; for the minification bug specifically, `npx gulp buildRelease` + a Playwright `instanceof` assert + grep the minified bundle to confirm the string-compare is gone.
- **Dependencies**: None. Unblocks Batch 3 (the manual-lerp blend is reused by the polyline morph port).

## BATCH 2 — Confirm Billboard/Point/Label render in 2D/CV/morph ⚠️ DONE — CRITICAL FINDING (2026-06-07)
**Verdict:** NOT a 2D/CV gap — billboard/point/label render NOTHING on WebGPU in **all** modes (3D/2D/CV), pre-existing (≥ Batch 214). The audit's "structurally correct" code-read did not match runtime (the classic trap). Promoted to P0/P1: `WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER` in DEFERRED_WORK. Reproducers: `probe-collections-2dcv-morph.mjs`, `probe-collections-entity.mjs`. Ruled out: module-instance, distance, timing, readback (PNGs read), entity-vs-raw, double-render, depth-occlusion. PolylineCollection DOES render (opaque path works). This likely **outranks Batch 3** — billboards/points/labels are broken in every mode, not just 2D/CV. Original Batch-2 scope below (superseded):
- **Item IDs**: MORPH-COLLECTIONS-AUDIT (Billboard/Point/Label only)
- **Severity / effort**: P1 (audit; may downgrade to "no fix") / S
- **Scope**: The audit found Billboard/Point/Label are *structurally* correct on WebGPU (read `bb._actualPosition`, pack a mode-aware `mvpRelativeToEye`, `_actualPosition` computed in the shared `updateMode` before the FR branch). But screenshots showed markers missing even in 3D — likely a probe artifact (markers under the nav widget; `drawImage()` color-readback unreliable for billboard/point/label on the WebGPU canvas). Isolate: place markers offset from UI, confirm 3D first, then flip to 2D/CV/morph and verify via PNGs (not px counts). Outcome: a verdict ("at parity, close" or "real gap → new candidate"). No code expected unless a gap surfaces.
- **Files**: `Tools/visual-regression/probe-collections-2dcv-morph.mjs` (harden marker placement); `FEATURE_INVENTORY.md` + `DEFERRED_WORK.md` (verdicts).
- **Dependencies**: None. Sequenced before Batch 3 so Batch 3's anchor-overlap assertion rests on confirmed-correct markers.

## BATCH 3 — PolylineCollection 2D / Columbus / Morph port (the big P1) ✅ DONE (Phase 3 Slice 4, 2026-06-13)
- **Item IDs**: MORPH-POLYLINE-COLLECTION-2D (== the audit's Polyline verdict)
- **Severity / effort**: P1 / L
- **Outcome**: SHIPPED. Took the SIMPLER CPU-blend strategy (mirroring billboard/point/label's `_actualPosition`) rather than the planned dual-stream WGSL `czm_columbusViewMorph` approach: the segment + pick builders encode `SceneTransforms.computeActualEllipsoidPosition` per endpoint (which itself does the CV `.zxy` swizzle + the MORPHING morphTime lerp CPU-side), so the existing mode-aware `mvpRelativeToEye` projects them in all four modes with the WGSL UNCHANGED. Camera stays `inverse(modelMatrix) * positionWC` (already projected-frame-correct in 2D/CV — re-projecting it was the first wrong turn, caught probe-first). Two more fixes needed beyond positions: full-frustum log-depth encode (`_logDepthEncodeNearFar`) for per-slice consistency with the globe, and a `noDepthTest` pipeline variant honoring WebGL's `useDepthTest = morphTime !== 0.0` (the CV "truncated wedge" was a z-fight against the co-planar map, not a projection bug — confirmed by hiding the globe). Verified `probe-collections-2dcv-morph.mjs`: polyline cyan 2D 0.96 / CV 0.89 / 3D 0.96 vs WebGL; all standing gates green. **Deferred to the Phase-3-continuation queue:** antimeridian (IDL) split, mid-morph polyline velocity (MORPH-TAA-PREVVP). See DEFERRED_WORK MORPH-POLYLINE-COLLECTION-2D for full detail.
- **Scope**: `WebGPUPolylineRenderer.js` is entirely SceneMode-unaware: encodes raw 3D ECEF (`buildSegmentDataForGroup:271-310`, `buildPickSegmentData:406-429`), single `mvpRelativeToEye` (`packCameraUniforms:919-1003`), `PolylineCollection.wgsl` vertexMain (`:96-106`) does one `mvpRelativeToEye*RTE` — no position2D attribute, no morphTime blend. In steady 2D/CV the lines project 3D ECEF through a 2D view and wander off-anchor; through morph they slide. WebGL (`PolylineVS.glsl:39-65`) branches on `czm_morphTime` over dual position3D/position2D streams. Fix mirrors the verified `WebGPUGroundPolylineRenderer` template: (1) build a CPU-projected position2D stream (`cartographic → mapProjection.project → ENU` in the WebGL `.zxy` convention) alongside 3D; (2) extend `packCameraUniforms` with a 2D/CV view-projection + sceneMode + morphTime (keep `previousViewProjection` at tail); (3) branch the VS — morphTime==1 → 3D RTE, ==0 → 2D RTE, else `csm_columbusViewMorph` manual-lerp blend; (4) recreate the segment buffer on mode flip via a `positionSourceKey` cache. Keep the SCENE3D `defines=0` path byte-identical. **Critical**: encode the camera in the SAME projected ENU frame as the 2D positions (the off-screen-RTE precision trap that bit GroundPrimitive). Defer the antimeridian (IDL) split to a sub-task.
- **Files**: `WebGPUPolylineRenderer.js`, `Shaders/WebGPU/Collections/PolylineCollection.wgsl` + `PolylineCollectionPick.wgsl`, reuse `csm_columbusViewMorph.wgsl`; new `probe-polyline-collection-scenemode.mjs`; docs (correct the stale Polyline SHIPPED tag). Check material variants (Arrow/Dash/Glow/Outline) inherit the base VS before editing.
- **Verification**: new `probe-polyline-collection-scenemode.mjs` — Entity polyline + co-located billboard at one endpoint; flip to 2D then CV; assert 0 device errors, polyline pixels overlap the billboard anchor within a few px, cyan ratio rises from ~0 to within ~6-10% of WebGL; extend `probe-morph-midframe.mjs` for the mid-morph PNG.
- **Dependencies**: Batch 1 (reuse the manual-lerp blend), Batch 2 (anchor-overlap assumes correct billboard).
- **Risk**: Medium — axis-convention (`.zxy`) errors silently mirror lines; 2D-leg camera must be in the projected ENU frame; buffer-layout growth touches vertexMain/pick/velocity VS + both VB layouts; keep SCENE3D byte-identical.

---

## Backlog — pending scoping (7 candidates hit the rate-limit; scope into batches next planning pass)

| ID | Sev | Effort | Note |
|---|---|---|---|
| ~~MORPH-EXAG-SKIRTS~~ | P1 | L | ✅ SHIPPED (Batch 362; re-verified live 2026-07-05). WebGL-faithful attribute-based skirt handling in the planar leg (`GlobeTerrain.wgsl` exaggerates the height ATTRIBUTE, not the geometric `length()` — mirrors `GlobeVS.glsl:245-258`). `probe-exaggeration-cv.mjs` EXAG=10 CV matches WebGL, zero walls; off-gate EXAG=1 CV normal. Residual GroundPrimitive ~1s morph-disappearance transient → MORPH-REVIEW-GAPS (COMPLETION-POP). |
| CLASSIFIER-2D-CV | P1 | M-L | Vector3DTile polyline + clamped-polyline classifiers SCENE2D/CV are gated; primitive classifier 2D/CV implemented but e2e-unverified (no `.vctr` test data). Ungate + verify. |
| MORPH-REVIEW-GAPS | (verify) | M | Verify the 4 unverified review-gaps: MORPH-PICK (pickWorldCoordinates mid-morph), MORPH-COMPLETION-POP, MORPH-CAMERA-FRUSTUM (animated FOV vs cached split/HiZ), MORPH-MULTIVIEW (split-screen frame-lock). Probe-driven. |
| GROUNDPRIM-RECON-PRECISION | P2 | M | Ground-primitive depth-sample classifier far-corner reconstruction-precision degradation (log-depth-gated). |
| MORPH-MODEL-PROJECT2D | P2 | M | glTF Model accurate-2D (`projectTo2D:true`) has no WGSL `position2D`/`u_modelView2D`/USE_2D path. Opt-in; default at parity. |
| MORPH-TAA-PREVVP | P2 | M | `previousViewProjection` not guarded across the perspective↔ortho mode-flip frame → TAA/motion-vector smear. Needs TAA-enabled mid-morph probe. |
| MORPH-PREVMODE-TYPO | P3 | S | `SceneTransitioner.js:1083` `_previousModeMode` typo (disputed). Likely document-only / human call — do NOT blind-rename. |

---

## Recommended execution order
1. **Batch 1** (this session) — two P2 quick wins, unblocks Batch 3.
2. **Batch 2** — billboard/label/point audit confirmation (cheap, gates Batch 3 verification).
3. **Batch 3** — PolylineCollection 2D/CV/morph port (the big P1).
4. Re-scope the 7 backlog items (re-run the planning workflow when rate-limits clear) and interleave: `CLASSIFIER-2D-CV` and `MORPH-EXAG-SKIRTS` are the next P1s; `MORPH-REVIEW-GAPS` is a cheap verification pass; the rest are P2/P3.
