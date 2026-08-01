/**
 * Multi-frustum dispatch loop extracted from
 * `WebGPUSceneRenderer.executeCommands`.
 *
 * Batch 140 of the audit-recommended SceneRenderer decomposition —
 * Slice C of the executeCommands four-slice plan (see
 * `migration_doc/BATCH_138_PLAN_EXECUTE_COMMANDS_SLICE_PLAN.md`).
 *
 * This is the heart of the scene render: walks the frustum list
 * far-to-near and dispatches every per-frustum pass:
 *
 *   - 2D-jitter setup (SCENE2D mode only)
 *   - capturedFrustumRanges bookkeeping for the debug overlay
 *   - frustum uniform refresh + currentFrustumIndex update
 *   - depth/stencil clear (gated on debugShowDepthAsColor)
 *   - ENVIRONMENT pass (farthest frustum only)
 *   - GLOBE pass + globe-depth copy (when useGlobeDepthFramebuffer)
 *   - TERRAIN_CLASSIFICATION pass + optional clearGlobeDepth +
 *     depth-plane render
 *   - 3D-tile chain with depth-update hook between main + classification
 *   - VOXELS sort + dispatch
 *   - OPAQUE pass
 *   - GAUSSIAN_SPLATS — deferred to OIT when supported, else inline
 *   - second frustum-uniform refresh (use exact near for translucent
 *     to avoid blending artifacts)
 *   - refraction capture (KHR_materials_transmission, Batch 107)
 *   - TRANSLUCENT pass
 *   - translucent-depth pack for classification (Batch 47/61/78)
 *   - per-frustum pick-depth copy
 *
 * The body has 7 callbacks into the SceneRenderer + 7 field reads/
 * writes — `FrustumLoopHost` interface enumerates the surface.
 *
 * @module WebGPUSceneRendererFrustumLoop
 */

import Pass from "../../Renderer/Pass.js";
import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import type { WebGPUOIT } from "./WebGPUOIT.js";
import type { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import type { WebGPUTranslucentTileClassification } from "./WebGPUTranslucentTileClassification.js";
import { getInvertClassificationDepthTexture } from "./WebGPUInvertClassification.js";
import {
  hasWebGPUPointCloudEDL,
  renderFrustumWebGPUPointCloudEDL,
} from "./WebGPUPointCloudEyeDomeLighting.js";
import {
  sortCommandsBackToFront,
  sortGaussianSplatsBackToFront,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";
import type { WebGPUCpuPassProfiler } from "./WebGPUCpuPassProfiler.js";
import {
  publishCurrentFrustumState,
  publishLogDepthEncodeNearFar,
} from "./WebGPUSceneRendererFrustumState.js";

/**
 * SceneRenderer surface the frustum-loop helper reaches back to.
 * Field reads/writes on the left; method callbacks on the right.
 */
export interface FrustumLoopHost {
  // ── Field reads ──
  _globeDepth: WebGPUGlobeDepth | null;
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  _oit: WebGPUOIT | null;
  _translucentTileClassification: WebGPUTranslucentTileClassification | null;
  _cpuPassProfiler: WebGPUCpuPassProfiler;
  // C7-SPLAT-DEPTH-COMPOSE — opt-in GS-WSR OIT deferral (default false =
  // WebGL-parity inline execution). See the flag's doc on WebGPUSceneRenderer.
  _splatOITDeferral: boolean;

  // ── Field writes ──
  _capturedFrustumRanges: { near: number; far: number }[];
  _currentFrustumIndex: number;
  _deferredOITSplats: {
    commands: CesiumAnyDrawCommand[];
    count: number;
  } | null;

  // ── Method callbacks ──
  _updateFrustumUniforms(
    uniformState: CesiumUniformState,
    near: number,
    far: number,
    scene: CesiumScene,
  ): void;
  _clearDepthStencil(context: WebGPUContext): void;
  _executePassCommands(
    frustumCommands: CesiumFrustumCommands,
    passIndex: number,
    scene: CesiumScene,
    context: WebGPUContext,
    passState: CesiumPassState,
  ): void;
  _executeGlobePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void;
  _renderDepthPlane(
    config: WebGPURenderFrameConfig,
    passKind: "scene" | "pick",
  ): void;
  _execute3DTilePasses(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
    onAfterTileMainPass?: () => void,
  ): void;
  _executeOpaquePass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void;
  _executeTranslucentPass(
    frustumCommands: CesiumFrustumCommands,
    config: WebGPURenderFrameConfig,
  ): void;
  _captureRefractionScene(config: WebGPURenderFrameConfig): void;
  _resumeScenePass(context: WebGPUContext): void;
}

/**
 * Walk the frustum list far-to-near and dispatch every per-frustum
 * pass. Caller (`executeCommands` on the SceneRenderer) is responsible
 * for the per-frame state reset + scene-FB pass redirect that runs
 * before this; and the post-frustum-tail (overlay, depth plane, env
 * effects, composite, velocity, post-process) runs after.
 *
 * @param host - The owning SceneRenderer.
 * @param config - Render-frame config from `executeCommands`.
 * @param opaqueFrustumNearOffset - Per-frame offset (default 0.9999)
 *   applied to non-nearest-frustum near planes to avoid tearing.
 */
export function executeFrustumLoop(
  host: FrustumLoopHost,
  config: WebGPURenderFrameConfig,
  opaqueFrustumNearOffset: number,
): void {
  const { scene, context, passState, picking } = config;
  const view = scene._view;
  const frustumCommandsList = view.frustumCommandsList;
  const numFrustums = frustumCommandsList.length;
  const uniformState = context.uniformState;

  // C-R8-SCENE2D-JITTER (Batch 36) — capture the initial 2D camera
  // altitude before the frustum loop so we can offset per-frustum
  // inside 2D mode. WebGL's `SceneRenderer.js:419,444-449` does this
  // to compress the 2D near/far range into [1, far-near+1] so the
  // ortho depth buffer has uniform precision across frustums instead
  // of banding where tiles intersect a frustum boundary. `.position`
  // lives on the real `Camera.js` instance (line 175) but isn't
  // declared on the ambient `CesiumCamera` shape — cast to read.
  const scene2DCamera = scene.camera as unknown as {
    position: { z: number };
  };
  const initialHeight2D =
    scene.mode === 2 /* SceneMode.SCENE2D */ ? scene2DCamera.position.z : 0;

  // NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION — capture the REAL camera frustum
  // (near, far) the globe log-encodes the entire depth texture against, BEFORE
  // the per-slice loop runs. CRITICAL: read `scene.camera` (the persistent
  // camera, far ~1e10), NOT `scene._frameState.camera` — the multi-frustum
  // machinery SLICES the frameState camera's frustum to per-band near/far
  // (~5e5), which is NOT what the replayed globe command encoded with. The globe
  // packs `uniformState.currentFrustum` (= scene.camera.frustum) at scene-update
  // and replays unchanged, so scene.camera.frustum here equals its encode
  // frustum exactly. Depth-sample classifiers read this via fstate.encodeFrustum
  // to decode eye distance, then unproject with the per-slice projection.
  publishLogDepthEncodeNearFar(scene, uniformState);

  // --- Multi-frustum loop: iterate from FAR to NEAR ---
  // This matches the WebGL path in Scene.js which goes (numFrustums - 1 - i)
  for (let i = 0; i < numFrustums; i++) {
    const index = numFrustums - i - 1;
    const frustumCommands = frustumCommandsList[index];

    // C-R8-SCENE2D-JITTER (Batch 36) — 2D-mode per-frustum offset.
    // Mirrors `SceneRenderer.js:444-449`: compress far-near to [1,
    // far-near+1] and shift camera.z to keep ortho depth precision
    // consistent across frustum boundaries.
    let near;
    let far;
    if (scene.mode === 2 /* SceneMode.SCENE2D */ && numFrustums > 1) {
      // C-R8-SCENE2D-JITTER (Batch 36) — only apply the camera-Z compress
      // trick when there are multiple frustums. The trick shifts
      // `camera.position.z` per-frustum to compress each band into a
      // narrow [1, far-near+1] range so the ortho depth buffer keeps
      // uniform precision across frustum boundaries. With a single
      // frustum the shift drives the camera into the planar earth
      // (z≈1) and every tile gets clipped by the near plane — blank
      // viewport. Mirrors `SceneRenderer.js:444-449` which also has
      // implicit multi-frustum behavior.
      scene2DCamera.position.z = initialHeight2D - frustumCommands.near + 1.0;
      far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
      near = 1.0;
      // After shifting the camera Z, refresh the view/projection state
      // so the tile UBs pick up the new camera position. Mirrors WebGL
      // `SceneRenderer.js:448` (`uniformState.update(frameState)`).
      const us = uniformState as unknown as {
        update: (fs: typeof scene._frameState) => void;
      };
      us.update?.(scene._frameState);
    } else if (scene.mode === 2 /* SceneMode.SCENE2D */) {
      // Single-frustum SCENE2D — `frustumCommands` carries the slice
      // of depth this band would render (e.g., 9.3 Mm → 11.4 Mm above
      // the planar earth at default zoom), which would clip the
      // entire earth out of the frustum. With only one frustum the
      // band must cover the FULL visible range, so use the camera
      // frustum's own near/far rather than the band-specific values.
      // Mirrors WebGL's behavior in a single-band degenerate case.
      const camFrust = scene._frameState.camera?.frustum as
        { near?: number; far?: number } | undefined;
      near = camFrust?.near ?? frustumCommands.near;
      far = camFrust?.far ?? frustumCommands.far;
    } else {
      // Apply opaque near offset to avoid tearing artifacts between adjacent frustums
      // (except for the nearest frustum which uses the actual near value)
      near =
        index !== 0
          ? frustumCommands.near * opaqueFrustumNearOffset
          : frustumCommands.near;
      far = frustumCommands.far;
    }

    // Store the range indexed by the ORIGINAL frustum index (0 = nearest)
    // so `WebGPUDebugFrustumOverlay` can match the WebGL DebugInspector
    // bitmask order. `index` already points to the natural order.
    host._capturedFrustumRanges[index] = {
      near: frustumCommands.near,
      far,
    };

    host._updateFrustumUniforms(uniformState, near, far, scene);
    // Shared with the auxiliary pick loop; collection/classification
    // bind-group resolvers require the exact slice projection and index.
    publishCurrentFrustumState(host, context, uniformState, i, near, far);

    // Clear depth/stencil per frustum (but not color — color accumulates across frustums).
    //
    // EXCEPTION: when `debugShowDepthAsColor` is on, skip the inter-frustum
    // clear (except before the very first iteration, so we start with a
    // known-clean buffer). Without this, only the nearest frustum's
    // geometry survives into the depth texture that the debug overlay
    // samples — the user sees an all-cleared depth buffer at any camera
    // altitude where the globe lives in the far frustum. Depth-test
    // correctness is compromised for the debug frame (far-frustum geometry
    // may incorrectly occlude near-frustum geometry through stale depth),
    // but the viz is THE tool you'd reach for when something's wrong with
    // depth anyway, so the tradeoff is intentional.
    const debugDepthViz = scene?._frameState?.debugShowDepthAsColor === true;
    if (!debugDepthViz || i === 0) {
      host._clearDepthStencil(context);
    }

    // Pass 0: ENVIRONMENT (sky, sun, moon, atmosphere) — once in farthest frustum
    if (i === 0) {
      host._cpuPassProfiler.beginPass("environment");
      try {
        host._executePassCommands(
          frustumCommands,
          Pass.ENVIRONMENT,
          scene,
          context,
          passState,
        );
      } finally {
        host._cpuPassProfiler.endPass("environment");
      }
    }

    // Pass 2: GLOBE
    host._cpuPassProfiler.beginPass("globe");
    try {
      host._executeGlobePass(frustumCommands, config);
    } finally {
      host._cpuPassProfiler.endPass("globe");
    }

    // Copy globe depth for terrain clamping and picking.
    // C-R8-GLOBE-DEPTH-ENABLE (Batch 42) — pass the scene framebuffer
    // depth explicitly (that's where globe actually wrote). The
    // internal `_outputTarget` fallback inside GlobeDepth is never
    // written to by WebGPU scene code.
    if (host._globeDepth && config.useGlobeDepthFramebuffer) {
      const encoder: GPUCommandEncoder | undefined =
        context._currentCommandEncoder;
      if (encoder) {
        const depthSource: GPUTexture | undefined =
          host._sceneFramebuffer?.colorTarget?.getDepthTexture();
        // End current render pass so the depth texture is available for reading
        context.endCurrentRenderPass?.();
        host._globeDepth.executeCopyDepth(encoder, depthSource);
        // Resume the SCENE FRAMEBUFFER pass for subsequent commands —
        // not the canvas pass. `resumeDefaultRenderPass` would redirect
        // every following draw to the canvas swap-chain, leaving the
        // scene FB empty for the post-process chain to blit.
        host._resumeScenePass(context);
        // C-R8-EDGE-INLINE — publish the packed-depth view on the
        // context so model FS bind-group construction can sample
        // globe depth without reaching back through the renderer
        // hierarchy. C11-201 reuses the target-owned view; target recreation
        // on resize/device generation supplies a new identity automatically.
        const packedDepth = host._globeDepth.globeDepthTexture;
        // Batch 139 (NEW-LABEL-SDF-BIND-GROUP-CACHING) — also publish
        // the underlying texture. Keeping it available remains useful to
        // consumers that own their own aspect/view policy, while ordinary
        // effects can now key on the stable renderer-owned view directly.
        context._globeDepthTexture = packedDepth ?? null;
        context._globeDepthView =
          host._globeDepth.globeDepthTextureView ?? null;
      }
    }

    // Pass 3: TERRAIN_CLASSIFICATION
    host._executePassCommands(
      frustumCommands,
      Pass.TERRAIN_CLASSIFICATION,
      scene,
      context,
      passState,
    );

    // Clear globe depth if needed for primitives-on-top rendering.
    // Same debug bypass as the inter-frustum clear above — we want the
    // debug overlay to see globe + 3D-tiles depth together, not a buffer
    // that was wiped mid-frustum.
    if (config.clearGlobeDepth && !debugDepthViz) {
      host._clearDepthStencil(context);
      if (config.useDepthPlane) {
        host._renderDepthPlane(config, "scene");
      }
    }

    // Pass 4-7: 3D Tiles passes. C-R8 (Batch 35): pass a depth-update
    // hook so `globeDepth.executeUpdateDepth` fires between the main
    // `CESIUM_3D_TILE` pass and the classification passes — otherwise
    // classification reads pre-tile terrain-only depth and Z-fights
    // against 3D-tile surfaces.
    //
    // C-R8-INVERT-DEPTH-SOURCE (Batch 41): when invert classification
    // is active, tile geometry wrote to the invert FBO's own depth
    // (not scene depth), so the post-tile depth copy must sample
    // THAT depth texture or downstream consumers see globe-only
    // depth and Z-fight tiles. Mirrors the WebGL `depthStencilTexture`
    // argument at `SceneRenderer.js:576`.
    host._cpuPassProfiler.beginPass("3dTiles");
    try {
      host._execute3DTilePasses(frustumCommands, config, () => {
        if (host._globeDepth && config.useGlobeDepthFramebuffer) {
          const enc: GPUCommandEncoder | undefined =
            context._currentCommandEncoder;
          if (enc) {
            // C-R8-GLOBE-DEPTH-ENABLE (Batch 42) — default depth source
            // is the scene framebuffer's depth (that's where scene
            // commands actually wrote depth). When invert is on, tile
            // depth went into the invert FBO instead, so override
            // with the invert depth texture. Mirrors WebGL's explicit
            // `depthStencilTexture` argument at
            // `SceneRenderer.js:549-553` (default) and `:576` (invert).
            let depthSource: GPUTexture | undefined =
              host._sceneFramebuffer?.colorTarget?.getDepthTexture();
            if (config.useInvertClassification) {
              const invertOwner = (
                scene as unknown as {
                  _invertClassification?: CesiumObjectWithWebGPUCache;
                }
              )._invertClassification;
              if (invertOwner) {
                const invertDepth =
                  getInvertClassificationDepthTexture(invertOwner);
                if (invertDepth) {
                  depthSource = invertDepth;
                }
              }
            }
            context.endCurrentRenderPass?.();
            host._globeDepth.executeUpdateDepth(enc, depthSource);
            host._resumeScenePass(context);
          }
        }
      });
    } finally {
      host._cpuPassProfiler.endPass("3dTiles");
    }

    // C-R8 (Batch 35) — VOXELS moved before OPAQUE to match WebGL.
    // `SceneRenderer.js:606` runs `performVoxelsPass` BEFORE
    // `performPass(Pass.OPAQUE)`; previous WebGPU ordering ran voxels
    // after OPAQUE which mis-ordered volumetric media against opaque
    // depth. Back-to-front sort still applies.
    {
      const voxCount: number = frustumCommands.indices[Pass.VOXELS];
      if (voxCount > 0) {
        sortCommandsBackToFront(
          frustumCommands.commands[Pass.VOXELS],
          voxCount,
          scene,
        );
      }
    }
    host._cpuPassProfiler.beginPass("voxels");
    try {
      host._executePassCommands(
        frustumCommands,
        Pass.VOXELS,
        scene,
        context,
        passState,
      );
    } finally {
      host._cpuPassProfiler.endPass("voxels");
    }

    // Pass 8: OPAQUE
    host._cpuPassProfiler.beginPass("opaque");
    try {
      host._executeOpaquePass(frustumCommands, config);
    } finally {
      host._cpuPassProfiler.endPass("opaque");
    }

    // PARITY-PC-EDL — Point Cloud Eye-Dome Lighting composite. Runs right
    // after OPAQUE (where the point-cloud color commands would have drawn —
    // they were disabled by `WebGPUPointCloudEyeDomeLighting.update` when EDL
    // is on). Re-renders the recorded point clouds into an off-screen
    // (color + packed-depth) framebuffer and alpha-blends the darkened-edge
    // result back onto the scene FB. `hasWebGPUPointCloudEDL` is a single
    // boolean read on the off path (no EDL point clouds → no-op).
    if (!picking && hasWebGPUPointCloudEDL(context)) {
      renderFrustumWebGPUPointCloudEDL(
        context,
        scene._frameState,
        () => {
          host._resumeScenePass(context);
          return context._currentRenderPassEncoder ?? null;
        },
        context.scenePipelineFormat,
      );
    }

    // DP-H45 (Batch 257) — re-pack scene depth after the OPAQUE pass so
    // pickPosition/pickFromRay over opaque Model/Primitive surfaces reads
    // the model surface, not the globe behind it. OPAQUE models write into
    // the scene-framebuffer depth, but nothing re-copied that depth into
    // `globeDepthTexture` (the packed RGBA8 color texture that
    // `pickDepth.update` reads at the end of this frustum, see L662). The
    // post-globe `executeCopyDepth` (above) and post-3D-tiles
    // `executeUpdateDepth` (above) both run BEFORE opaque, so without this
    // block the picked depth is frozen at the pre-opaque (globe + tiles
    // only) state. WebGL has no equivalent gap because its
    // `pickDepth.update` samples the live shared depth attachment, which
    // already contains opaque-model depth after `performPass(Pass.OPAQUE)`
    // (`SceneRenderer.js:637` → `:656`). Mirrors the post-3D-tiles block
    // above (endCurrentRenderPass → executeUpdateDepth(sceneFB depth) →
    // _resumeScenePass). Gated on `!picking` to match the per-frustum
    // pick-depth copy below (L662) — that copy runs on the NORMAL render
    // frame, not the pick pass, so the depth must be repacked here on the
    // same `!picking` frame whose `globeDepthTexture` feeds `pickDepth`.
    if (
      !picking &&
      host._globeDepth &&
      config.useGlobeDepthFramebuffer &&
      scene._picking &&
      // Only repack when a pass after the preceding globe/tile publication
      // could have changed the live depth attachment. The multi-frustum globe
      // pick defect still reproduces with this gate removed, so it is tracked
      // separately as a shared packed-depth lifetime issue.
      ((frustumCommands.indices[Pass.OPAQUE] ?? 0) > 0 ||
        (frustumCommands.indices[Pass.VOXELS] ?? 0) > 0 ||
        (config.clearGlobeDepth && !debugDepthViz))
    ) {
      const enc: GPUCommandEncoder | undefined = context._currentCommandEncoder;
      if (enc) {
        const depthSource: GPUTexture | undefined =
          host._sceneFramebuffer?.colorTarget?.getDepthTexture();
        context.endCurrentRenderPass?.();
        host._globeDepth.executeUpdateDepth(enc, depthSource);
        host._resumeScenePass(context);
      }
    }

    // Pass 12: CESIUM_3D_TILE_EDGES_DIRECT (EDGES_ONLY mode).
    // C-R8-EDGE-DISPLAY-MODE (§5 P2) — direct CAD-wireframe edges drawn
    // straight onto the scene framebuffer ON TOP of opaque surfaces.
    // Mirrors WebGL's `performCesium3DTileEdgesDirectPass` ordering —
    // AFTER OPAQUE and BEFORE GAUSSIAN_SPLATS (`SceneRenderer.js:663-668`).
    // Unlike `CESIUM_3D_TILE_EDGES` (which the 3D-tile dispatcher
    // redirects into the MRT edge FBO for the Batch 44 composite), these
    // commands carry the single-target edge pipeline and render on the
    // active scene pass — no FBO redirect. Before this batch, slot-12
    // commands were binned by the frustum sorter but never executed
    // (the loop only ran VOXELS / OPAQUE / GAUSSIAN_SPLATS / TRANSLUCENT),
    // so EDGES_ONLY models rendered nothing on WebGPU. `_executePassCommands`
    // early-returns when the per-frustum slot-12 count is 0, so non-EDGES_ONLY
    // frames pay no cost.
    host._executePassCommands(
      frustumCommands,
      Pass.CESIUM_3D_TILE_EDGES_DIRECT,
      scene,
      context,
      passState,
    );

    // Pass 11: GAUSSIAN_SPLATS
    // GS-WSR: If the opt-in deferral flag is ARMED and OIT is available and
    // splat commands have OIT variants, defer them to the translucent OIT
    // pass for weighted-sum rendering. Otherwise (the WebGL-parity DEFAULT)
    // render inline with standard alpha blending — WebGL executes splats
    // inline in the scene pass, depth-tested against the scene depth, and
    // never routes them through OIT. C7-SPLAT-DEPTH-COMPOSE: pre-fix the
    // deferral was unconditional, and `executeTranslucentPass` early-returns
    // when the frame has zero TRANSLUCENT commands, so the deferred splats
    // were dropped every frame (presented as "the splat is occluded by the
    // opaque globe"). See `_splatOITDeferral` on WebGPUSceneRenderer.
    {
      const splatCommands = frustumCommands.commands[Pass.GAUSSIAN_SPLATS];
      const splatCount: number = frustumCommands.indices[Pass.GAUSSIAN_SPLATS];
      const hasOITSplats =
        host._splatOITDeferral &&
        host._oit?.isSupported &&
        config.useOIT &&
        !config.picking &&
        splatCount > 0 &&
        splatCommands[0]?._oitPipeline;

      if (hasOITSplats) {
        // Splats will be rendered in the OIT accumulation pass below
        // by injecting them into the translucent command list.
        // Store them for later use.
        host._deferredOITSplats = {
          commands: splatCommands,
          count: splatCount,
        };
      } else {
        if (splatCount > 0) {
          // GS uses alpha accumulation — non-OIT path must sort back-to-front.
          // Splats use a box-center distance metric (see
          // `backToFrontSplats` in Scene/CommandSorter.js) rather than the
          // sphere `distanceSquaredTo` used by generic translucent geometry.
          sortGaussianSplatsBackToFront(splatCommands, splatCount, scene);
        }
        host._executePassCommands(
          frustumCommands,
          Pass.GAUSSIAN_SPLATS,
          scene,
          context,
          passState,
        );
      }
    }

    // For translucent pass, use actual near to avoid blending artifacts
    if (
      index !== 0 &&
      scene.mode !== 2 /* SceneMode.SCENE2D */ &&
      (frustumCommands.indices[Pass.TRANSLUCENT] ?? 0) > 0
    ) {
      host._updateFrustumUniforms(
        uniformState,
        frustumCommands.near,
        far,
        scene,
      );
      publishCurrentFrustumState(
        host,
        context,
        uniformState,
        i,
        frustumCommands.near,
        far,
      );
    }

    // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — refraction capture.
    // Snapshots opaque-only scene color (after OPAQUE/MASK passes
    // and after voxels/splats) into a dedicated refraction target so
    // transmissive surfaces drawn in the TRANSLUCENT pass that
    // follows can sample "the world behind this glass" without
    // double-counting their own contribution. Gated on
    // `context._sceneHasTransmission` (set by the model emitter when
    // any primitive has FLAG_HAS_TRANSMISSION) so frames with no
    // transmissive primitives pay zero cost. Runs every frustum so
    // each transmissive draw sees the right per-frustum opaque
    // backdrop.
    host._captureRefractionScene(config);

    // Pass 9: TRANSLUCENT (with OIT if enabled)
    host._cpuPassProfiler.beginPass("translucent");
    try {
      host._executeTranslucentPass(frustumCommands, config);
    } finally {
      host._cpuPassProfiler.endPass("translucent");
    }

    // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — capture translucent
    // depth into the dedicated depth target so classification
    // primitives running in the next pass can clamp to the
    // translucent surface. First-cut implementation: copy from the
    // scene framebuffer's depth (over-broad — captures all
    // translucent contributors, not just 3D-tile content).
    // C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA scenes now
    // packed via the multisampled-depth pack pipeline (sample 0
    // resolve), no longer skipped. Runs every frustum so the
    // classification reads the right per-frustum depth, but only
    // the last frustum's depth survives into the composite
    // (multi-frustum accumulation is `C-R8-TRANSLUCENT-MULTI-FRUSTUM`).
    const tcc = host._translucentTileClassification;
    const has3DTileClassification =
      (frustumCommands.indices[Pass.CESIUM_3D_TILE_CLASSIFICATION] ?? 0) > 0;
    if (
      !picking &&
      tcc &&
      has3DTileClassification &&
      tcc.isSupported() &&
      host._sceneFramebuffer?.colorTarget
    ) {
      // The scene depth texture is sampleable when single-sample.
      // Capture happens via copyTextureToTexture so we need an
      // active command encoder; end any current render pass first.
      const enc: GPUCommandEncoder | undefined = context._currentCommandEncoder;
      if (enc) {
        // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 78) — gate the broad
        // scene-depth copy on whether any TRANSLUCENT command in this
        // frustum carries `depthForTranslucentClassification === true`.
        // `Cesium3DTile.js:1084` sets that flag on translucent 3D-tile
        // commands; nothing else in the engine sets it. When the
        // frustum's classification list is non-empty but no flagged
        // commands feed into the depth, the whole pack-depth pipeline
        // would feed off useless data (label/billboard depth, etc.) —
        // skipping it is correct. When at least one is flagged, the
        // broad copy still runs (truly selective rendering needs the
        // C-R8-TRANSLUCENT-MULTI-FRUSTUM per-frustum render pass
        // restructure, where the depth-only pipeline variants land).
        const translucentCmds = frustumCommands.commands[Pass.TRANSLUCENT];
        const translucentCount =
          (frustumCommands.indices[Pass.TRANSLUCENT] ?? 0) >>> 0;
        let flaggedCommandsPresent = false;
        for (let ti = 0; ti < translucentCount; ++ti) {
          const cmd = translucentCmds[ti] as unknown as
            | {
                depthForTranslucentClassification?: boolean;
              }
            | undefined;
          if (cmd?.depthForTranslucentClassification === true) {
            flaggedCommandsPresent = true;
            break;
          }
        }
        context.endCurrentRenderPass?.();
        const sceneDepthTex =
          host._sceneFramebuffer.colorTarget.getDepthTexture?.() ?? null;
        tcc.executeTranslucentDepthPass(
          enc,
          sceneDepthTex,
          flaggedCommandsPresent,
        );
        // Pack the captured depth so classification pipelines can
        // sample it as a regular texture. Internally early-exits when
        // `_hasTranslucentDepth` is false (the gating above sets it).
        const opaqueSampleableView =
          host._sceneFramebuffer.colorTarget.getDepthSampleableView?.() ?? null;
        tcc.executePackDepth(enc, opaqueSampleableView);
        // Migration Session 2 — publish the packed-translucent-depth
        // view on the context so the depth-sample classifier
        // (`WebGPUGroundPrimitiveRenderer`) can sample it instead of
        // `_globeDepthView` for translucent-on-translucent
        // classification. The getter returns `undefined` when no
        // translucent depth was captured this frame, which we
        // normalize to `null` so the consumer's existing null-check
        // pattern works. The view is recreated each frame from the
        // packed-depth texture; the classifier rebuilds its bind
        // group when the view ref changes.
        context._packedTranslucentDepthView =
          tcc.packedTranslucentDepthView ?? null;
        host._resumeScenePass(context);
      }
    }

    // Pick depth copy per frustum (for pickPosition support)
    if (
      !picking &&
      config.useGlobeDepthFramebuffer &&
      host._globeDepth &&
      scene._picking
    ) {
      const pickDepth = scene._picking.getPickDepth(scene, index);
      // Pass the packed-depth-as-color texture (RGBA8, from executeCopyDepth)
      // so PickDepth can read it via buffer copy + mapAsync
      const packedDepthTex = host._globeDepth.globeDepthTexture;
      if (pickDepth && packedDepthTex) {
        pickDepth.update(context, packedDepthTex);
      }
    }
  }
}
