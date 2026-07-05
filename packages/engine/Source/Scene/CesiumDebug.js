import PostProcessStageLibrary from "./PostProcessStageLibrary.js";

/**
 * Console-accessible debug service for visual debugging of the WebGPU
 * renderer. Exposes toggle commands via `window.CesiumDebug` so you can
 * inspect the depth buffer, render pass state, pipeline health, etc.
 * from the browser DevTools console.
 *
 * Usage (in browser console):
 *   CesiumDebug.help()                    — list all commands
 *   CesiumDebug.showDepth()               — show depth buffer as grayscale
 *   CesiumDebug.hideDepth()               — restore normal rendering
 *   CesiumDebug.showWireframe()           — enable globe wireframe overlay
 *   CesiumDebug.hideWireframe()           — disable wireframe
 *   CesiumDebug.snapshot()                — dump full debug snapshot
 *   CesiumDebug.pipelineStatus()          — check shader/pipeline health
 *   CesiumDebug.showFrustums()            — colorize frustum splits
 *   CesiumDebug.hideFrustums()            — disable frustum viz
 *   CesiumDebug.toggleFPS()               — toggle FPS counter
 *   CesiumDebug.postProcess()             — dump post-process pipeline state
 *   CesiumDebug.canvasPixels()            — sample canvas pixels for diagnostics
 *
 * @private
 */

function installCesiumDebug(viewer) {
  if (!viewer || !viewer.scene) {
    console.warn("[CesiumDebug] No viewer provided — debug tools unavailable.");
    return;
  }

  const scene = viewer.scene;

  // WebGL's showDepth path uses upstream Cesium's PostProcessStageLibrary
  // `createDepthViewStage` (czm_depth_view), added to / removed from
  // `scene.postProcessStages` on toggle. WebGPU uses its own
  // `debugShowDepthAsColor` frameState flag which activates
  // `WebGPUDebugDepthOverlay` inside the WebGPU post-process path. One
  // user-facing command, two backend-appropriate implementations.
  let webglDepthViewStage = null;

  // Depth / frustums / commands overlays share the same post-process slot
  // in the WebGPU scene renderer (the first enabled flag wins and returns
  // early from `_runPostProcessing`). Making the three modes mutually
  // exclusive at the JS level prevents the "enable one, it breaks, then
  // the next enable still routes to the broken one because the prior
  // flag is still set" footgun — you cannot get stuck in multiple
  // overlay states at once. Each `show*` helper calls this first.
  function clearAllOverlays() {
    scene.debugShowDepthAsColor = false;
    scene.debugShowFrustums = false;
    scene.debugShowCommands = false;
    if (webglDepthViewStage) {
      webglDepthViewStage.enabled = false;
    }
  }

  const CesiumDebug = {
    /**
     * List available commands.
     */
    help() {
      console.log(`
╔══════════════════════════════════════════════════════╗
║              CesiumDebug Console Commands            ║
╠══════════════════════════════════════════════════════╣
║  CesiumDebug.help()            — this help           ║
║  CesiumDebug.snapshot()        — full debug snapshot  ║
║  CesiumDebug.showDepth()       — depth buffer viz     ║
║  CesiumDebug.showGBufferNormals() — G-buffer normal viz ║
║  CesiumDebug.hideDepth()       — restore normal       ║
║  CesiumDebug.showWireframe()   — globe wireframe      ║
║  CesiumDebug.hideWireframe()   — hide wireframe       ║
║  CesiumDebug.showFrustums()    — frustum color viz    ║
║  CesiumDebug.hideFrustums()    — hide frustum viz     ║
║  CesiumDebug.showCommands()    — command count overlay ║
║  CesiumDebug.hideCommands()    — hide command overlay  ║
║  CesiumDebug.toggleFPS()       — toggle FPS counter   ║
║  CesiumDebug.pipelineStatus()  — shader/pipeline check║
║  CesiumDebug.postProcess()     — post-process state   ║
║  CesiumDebug.canvasPixels()    — sample canvas data    ║
║  CesiumDebug.logImageryProbe() — next 4 tile updates   ║
║  CesiumDebug.cpuPassCost(t/f)  — CPU per-pass cost (R-7a) ║
║  CesiumDebug.gpuPassCost()     — GPU per-pass cost (timestamp) ║
║  CesiumDebug.highDensityCull() — gpuCuller/HiZ/sort-keys stats ║
║  CesiumDebug.globeBindGroups() — globe bind-group cache stats ║
║  CesiumDebug.globeFragmentDebug(name) — visualize FS stages ║
║  CesiumDebug.globeFragmentDebug()        — list available modes ║
╚══════════════════════════════════════════════════════╝
      `);
    },

    /**
     * Override globe-tile `fragmentMain` to return a visualization of one
     * intermediate value (UVs, texCoordsMask, per-layer alpha, drape inputs,
     * etc.). Useful for narrowing down per-tile rendering bugs without
     * recompiling — flip a mode, reload your scene, take a screenshot,
     * flip another.
     *
     * Usage:
     *   CesiumDebug.globeFragmentDebug()             — list modes (no-op)
     *   CesiumDebug.globeFragmentDebug("uv")         — show vertex UVs
     *   CesiumDebug.globeFragmentDebug("post-composite-color")
     *                                                — show imagery before drape
     *   CesiumDebug.globeFragmentDebug(null)         — disable
     *
     * Pragma-stripped from production builds (the tile-UB writer that
     * picks up the mode lives inside `//>>includeStart('debug')`). Set
     * mode persists across `scene.requestRender()` calls.
     */
    globeFragmentDebug(name) {
      // Importing here keeps the helper out of the cold path; the registry
      // module is tiny (~150 lines, no side effects at load) so a sync
      // require would also be fine.
      const registry = (globalThis.__webgpuGlobeFragmentDebugRegistry =
        globalThis.__webgpuGlobeFragmentDebugRegistry || null);
      if (name === undefined) {
        // List modes. Pulled from the registry global the renderer
        // populates at init; if the renderer hasn't run yet, fall back
        // to a clear "no modes available" hint.
        if (!registry || registry.length === 0) {
          console.log(
            "[CesiumDebug] globeFragmentDebug: registry not yet populated " +
              "(render at least one frame first). After that, this command " +
              "lists every available mode.",
          );
          return;
        }
        console.log("[CesiumDebug] globeFragmentDebug modes:");
        for (const m of registry) {
          console.log(`  ${m.name.padEnd(24)} ${m.description}`);
        }
        return;
      }
      globalThis._webgpuGlobeDebugMode = name || null;
      if (name) {
        console.log(
          `[CesiumDebug] globeFragmentDebug set to '${name}'. ` +
            `Call CesiumDebug.globeFragmentDebug(null) to clear.`,
        );
      } else {
        console.log("[CesiumDebug] globeFragmentDebug cleared.");
      }
      scene.requestRender();
    },

    /**
     * Full debug snapshot — dumps everything.
     */
    snapshot() {
      if (typeof scene.logDebugSnapshot === "function") {
        scene.logDebugSnapshot();
      } else if (typeof scene.getDebugSnapshot === "function") {
        console.log(JSON.stringify(scene.getDebugSnapshot(), null, 2));
      } else {
        console.warn("[CesiumDebug] getDebugSnapshot not available");
      }
    },

    /**
     * Show depth buffer as grayscale overlay (replaces normal rendering).
     */
    showDepth() {
      clearAllOverlays();
      // WebGPU: flag flows through Scene.js → frameState → the WebGPU
      // scene renderer's `_executeDebugDepthOverlay` replaces the normal
      // post-process chain. Scene.js:2676 propagates the scene property
      // to frameState each frame — setting frameState directly would be
      // clobbered.
      scene.debugShowDepthAsColor = true;

      // WebGL: the WebGPU flag above is a no-op on a WebGL context, so
      // we ALSO install upstream's `czm_depth_view` post-process stage
      // on the scene's PostProcessStageCollection. The stage samples the
      // depth texture and outputs grayscale — the WebGL equivalent of
      // WebGPUDebugDepthOverlay's linearized mode 0.
      if (!scene._context?.isWebGPU) {
        if (!webglDepthViewStage) {
          webglDepthViewStage = PostProcessStageLibrary.createDepthViewStage();
          scene.postProcessStages.add(webglDepthViewStage);
        }
        webglDepthViewStage.enabled = true;
      }

      scene.requestRender();
      console.log("[CesiumDebug] Depth buffer visualization ON");
    },

    /**
     * Restore normal rendering from depth viz.
     */
    hideDepth() {
      scene.debugShowDepthAsColor = false;
      scene.debugDepthWindowMin = 0;
      scene.debugDepthWindowMax = 0;
      if (webglDepthViewStage) {
        webglDepthViewStage.enabled = false;
      }
      scene.requestRender();
      console.log("[CesiumDebug] Depth buffer visualization OFF");
    },

    /**
     * Show the depth buffer as a WINDOWED color overlay (WebGPU): spend the
     * full Turbo color range on the eye-space distance band
     * <code>[minMeters, maxMeters]</code>, so two near-identical depths get
     * distinct hues (low = blue, mid = green, high = red). Use this when the
     * plain {@link CesiumDebug#showDepth} collapses everything to one shade —
     * e.g. a building flush on terrain at far ≈ 1e8. Pass
     * <code>turbo=false</code> for windowed grayscale.
     *
     * Example — inspect a building footprint at ~188 m:
     *   CesiumDebug.showDepthWindow(180, 200);
     *
     * @param {number} minMeters band start (eye-space distance, meters)
     * @param {number} maxMeters band end (must be &gt; minMeters)
     * @param {boolean} [turbo=true] Turbo colormap vs grayscale
     */
    showDepthWindow(minMeters, maxMeters, turbo) {
      clearAllOverlays();
      scene.debugShowDepthAsColor = true;
      scene.debugDepthWindowMin = +minMeters || 0;
      scene.debugDepthWindowMax = +maxMeters || 0;
      scene.debugDepthWindowTurbo = turbo !== false;
      scene.requestRender();
      console.log(
        `[CesiumDebug] Windowed depth overlay ON: [${scene.debugDepthWindowMin}, ${scene.debugDepthWindowMax}] m, ${scene.debugDepthWindowTurbo ? "turbo" : "grayscale"} (WebGPU only)`,
      );
    },

    /**
     * Skip the ellipsoid depth-plane render (debug bisect for C-R9 — terrain-
     * flush 3D-Tiles / b3dm invisible on WebGPU). The depth plane is drawn
     * between the globe and 3D-Tiles when <code>clearGlobeDepth</code> is active
     * (the default). If content reappears with this ON, the depth plane is
     * writing a depth nearer than the content and occluding it. Applies to both
     * backends. Call with no arg / <code>true</code> to skip; <code>false</code>
     * to restore.
     *
     * @param {boolean} [on=true]
     */
    skipDepthPlane(on) {
      scene.debugSkipDepthPlane = on !== false;
      scene.requestRender();
      console.log(
        `[CesiumDebug] Ellipsoid depth plane ${scene.debugSkipDepthPlane ? "SKIPPED" : "restored"}`,
      );
    },

    /**
     * Phase 8a Slice 2c (Batch 89) — visualize the G-buffer normal
     * texture as a fullscreen overlay. Surface normals are mapped
     * `(n + 1) * 0.5` to RGB so the standard normal-map color
     * convention applies: +X right is red, +Y up is green, +Z toward
     * camera is blue. Magenta pixels are sentinels (sky, depth-clear,
     * or high-gradient samples where the producer couldn't safely
     * reconstruct a normal).
     *
     * Auto-enables `scene.deferredLighting` so the G-buffer producer
     * actually runs this frame. WebGPU-only — no-op on WebGL.
     */
    showGBufferNormals() {
      clearAllOverlays();
      scene.deferredLighting = true;
      scene.debugShowGBufferNormals = true;
      scene.requestRender();
      console.log(
        "[CesiumDebug] G-buffer normal visualization ON. Call CesiumDebug.hideGBufferNormals() to restore.",
      );
    },

    /**
     * Restore normal rendering from G-buffer normal viz. Leaves
     * `scene.deferredLighting` on so consumers (SSAO/SSR) continue
     * reading the G-buffer; call `scene.deferredLighting = false`
     * manually to fully disable the producer.
     */
    hideGBufferNormals() {
      scene.debugShowGBufferNormals = false;
      scene.requestRender();
      console.log("[CesiumDebug] G-buffer normal visualization OFF");
    },

    /**
     * Show globe wireframe overlay.
     */
    showWireframe() {
      scene.debugShowGlobeWireframe = true;
      scene.requestRender();
      console.log("[CesiumDebug] Globe wireframe ON");
    },

    /**
     * Hide globe wireframe.
     */
    hideWireframe() {
      scene.debugShowGlobeWireframe = false;
      scene.requestRender();
      console.log("[CesiumDebug] Globe wireframe OFF");
    },

    /**
     * Colorize per frustum membership.
     *
     * WebGL: routed through `DebugInspector.js` which clones each
     * command's shader program and multiplies `out_FragColor.rgb` by a
     * bitmask RGB tint encoding `command.debugOverlappingFrustums`.
     *
     * WebGPU: routed through `WebGPUDebugFrustumOverlay` in place of the
     * normal post-process chain — samples the scene color + depth, maps
     * each pixel's linearized depth into the frustum range captured
     * during the frustum loop, and multiplies by the same bit-masked RGB
     * palette. Visually equivalent to the WebGL path for the case where
     * a single command isn't split across multiple frustums (the common
     * case for terrain / 3D Tiles).
     */
    showFrustums() {
      clearAllOverlays();
      scene.debugShowFrustums = true;
      scene.requestRender();
      console.log("[CesiumDebug] Frustum visualization ON");
    },

    hideFrustums() {
      scene.debugShowFrustums = false;
      scene.requestRender();
      console.log("[CesiumDebug] Frustum visualization OFF");
    },

    /**
     * Colorize by command / depth bucket.
     *
     * WebGL: `DebugInspector.js` assigns each `DrawCommand` a random
     * `_debugColor` and tints its fragments by that color — so each
     * command becomes visually distinct.
     *
     * WebGPU: `WebGPUDebugFrustumOverlay` mode 1. Per-command tinting
     * would require cloning every pipeline's fragment shader (WebGPU
     * pipelines are precompiled and can't take a per-draw uniform that
     * isn't in their bind group layout) — a huge surface. Instead the
     * overlay buckets linearized depth into 8 distinct colors, which
     * highlights depth clusters and roughly matches the "different
     * commands draw different colors" diagnostic intent of the WebGL
     * path.
     */
    showCommands() {
      clearAllOverlays();
      scene.debugShowCommands = true;
      scene.requestRender();
      console.log("[CesiumDebug] Command visualization ON");
    },

    hideCommands() {
      scene.debugShowCommands = false;
      scene.requestRender();
      console.log("[CesiumDebug] Command visualization OFF");
    },

    /**
     * Toggle FPS counter.
     */
    toggleFPS() {
      scene.debugShowFramesPerSecond = !scene.debugShowFramesPerSecond;
      console.log(
        `[CesiumDebug] FPS counter ${scene.debugShowFramesPerSecond ? "ON" : "OFF"}`,
      );
    },

    /**
     * Check shader module and pipeline health.
     */
    pipelineStatus() {
      const ctx = scene._context;
      if (!ctx) {
        console.warn("[CesiumDebug] No context");
        return;
      }

      const info = {
        backend: ctx.rendererType,
        contextId: ctx.id,
        hasDevice: !!ctx._device,
        deviceLost: ctx._deviceLost === true,
        hasRenderPass: !!ctx.currentRenderPassEncoder,
        hasCommandEncoder: !!ctx.currentCommandEncoder,
        depthTexture: !!ctx._depthTexture,
        depthView: !!ctx._depthTextureView,
        canvasWidth: ctx._canvas?.width,
        canvasHeight: ctx._canvas?.height,
        frameCount: ctx._frameCount,
      };

      // Check post-process pipeline
      // `_alternateSceneRenderer` lives on the Scene (see Scene.js:297),
      // NOT the context. Read it off the scene.
      const renderer = scene._alternateSceneRenderer;
      if (renderer) {
        info.postProcess = !!renderer._postProcess;
        info.sceneFramebuffer = !!renderer._sceneFramebuffer;
        if (renderer._postProcess) {
          info.postProcessHasActive = renderer._postProcess.hasActiveStages;
        }
        if (renderer._sceneFramebuffer) {
          const fb = renderer._sceneFramebuffer;
          info.sceneColorTarget = !!fb.colorTarget;
          info.sceneColorView = !!fb.colorTarget?.getColorTextureView?.(0);
        }
      }

      console.table(info);
      return info;
    },

    /**
     * Toggle and dump CPU-side per-pass recording-cost profile (R-7a).
     * Pass `true` to enable, `false` to disable, or no argument to dump
     * the current rolling-window stats. Useful for deciding which passes
     * are worth GPURenderBundle expansion (>5 ms = strong candidate;
     * <1 ms = not worth it).
     *
     * Usage:
     *   CesiumDebug.cpuPassCost(true)   // enable + reset
     *   // ... let scene run for several seconds ...
     *   CesiumDebug.cpuPassCost()       // dump rolling-window stats
     *   CesiumDebug.cpuPassCost(false)  // disable
     */
    cpuPassCost(enabled) {
      const renderer = scene._alternateSceneRenderer;
      if (!renderer || typeof renderer.getCpuPassProfile !== "function") {
        console.warn(
          "[CesiumDebug] CPU pass profiler unavailable (WebGPU only)",
        );
        return;
      }
      if (enabled === true || enabled === false) {
        renderer.setCpuPassProfiling(enabled);
        console.log(
          `[CesiumDebug] CPU pass profiling ${enabled ? "ON" : "OFF"}`,
        );
        return;
      }
      const profile = renderer.getCpuPassProfile();
      if (!profile.enabled) {
        console.warn(
          "[CesiumDebug] CPU pass profiling is OFF — call cpuPassCost(true) first",
        );
        return profile;
      }
      const rows = Object.values(profile.passes).map((p) => ({
        pass: p.name,
        avgMs: p.avgMs.toFixed(3),
        lastMs: p.lastMs.toFixed(3),
        minMs: p.minMs.toFixed(3),
        maxMs: p.maxMs.toFixed(3),
        samples: p.samples,
      }));
      rows.sort((a, b) => Number(b.avgMs) - Number(a.avgMs));
      console.log(
        `[CesiumDebug] CPU pass cost (frames=${profile.frameCount}):`,
      );
      console.table(rows);
      return profile;
    },

    /**
     * AUDIT_2026_05_02 C.5 — dump GPU-side per-pass timing from
     * `WebGPUTimestampProfiler`. Requires the `timestamp-query` device
     * feature to be enabled (gated by `WebGPUFeatureFlags`); on adapters
     * without it, the profiler still allocates but `getResults()` returns
     * `enabled: false`.
     *
     * Unlike CPU pass cost, GPU timings show the actual shader-execution
     * cost on the device — useful for deciding which passes are GPU-bound
     * (lower values for compute or simpler shaders, higher for fillrate-
     * bound passes like Bloom or AO).
     *
     * Usage:
     *   CesiumDebug.gpuPassCost()        // dump rolling-window stats
     */
    gpuPassCost() {
      const ctx = scene._context;
      if (!ctx?.isWebGPU) {
        console.warn("[CesiumDebug] GPU pass profiler is WebGPU-only");
        return;
      }
      const profiler = ctx.timestampProfiler;
      if (!profiler) {
        console.warn(
          "[CesiumDebug] timestamp-query feature not available on this adapter",
        );
        return;
      }
      const results = profiler.getResults();
      if (!results.enabled) {
        console.warn(
          "[CesiumDebug] GPU pass profiler is disabled (timestamp-query " +
            "feature not active or not yet sampled)",
        );
        return results;
      }
      const rows = Object.entries(results.passes).map(([name, p]) => ({
        pass: name,
        avgMs: p.avgMs.toFixed(3),
        lastMs: p.lastMs.toFixed(3),
        minMs: p.minMs.toFixed(3),
        maxMs: p.maxMs.toFixed(3),
      }));
      rows.sort((a, b) => Number(b.avgMs) - Number(a.avgMs));
      console.log(
        `[CesiumDebug] GPU pass cost (frame=${results.frameMs.toFixed(3)}ms ` +
          `avg=${results.frameAvgMs.toFixed(3)}ms frames=${results.frameCount}):`,
      );
      console.table(rows);
      return results;
    },

    /**
     * Dump post-process pipeline state.
     */
    postProcess() {
      const renderer = scene._alternateSceneRenderer;
      if (!renderer?._postProcess) {
        console.warn("[CesiumDebug] No post-process pipeline");
        return;
      }
      const pp = renderer._postProcess;
      const state = {
        hasActiveStages: pp.hasActiveStages,
        tonemapEnabled: pp._tonemapStage?.enabled,
        fxaaEnabled: pp._fxaaStage?.enabled,
        taaEnabled: pp._taaEffect?.enabled,
        colorGradingEnabled: pp._colorGradingStage?.enabled,
        bloomEnabled: pp._bloomEffect?.enabled,
        aoEnabled: pp._aoEffect?.enabled,
        dofEnabled: pp._dofEffect?.enabled,
        pingTexture: !!pp._pingTexture,
        pongTexture: !!pp._pongTexture,
        width: pp._width,
        height: pp._height,
      };
      console.table(state);
      return state;
    },

    /**
     * Dump high-density GPU cull / HiZ / sort-keys effectiveness
     * (Batch 217). Shows the activation gate state, dispatch counts,
     * and per-frame hit ratio so users can verify the threshold-gated
     * dispatchers are actually pulling their weight on dense scenes.
     *
     *  - `active`: hysteresis state. True when count is keeping the
     *    dispatcher engaged.
     *  - `hitRatio`: fraction of input commands the GPU filter dropped.
     *    Above ~0.2 means the dispatcher is paying for itself; near 0
     *    means CPU cull was already tight enough.
     *  - `dispatches`: lifetime count since context init.
     */
    highDensityCull() {
      const renderer = scene._alternateSceneRenderer;
      if (!renderer || typeof renderer.getHighDensityCullStats !== "function") {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer (or stats not available)",
        );
        return null;
      }
      const stats = renderer.getHighDensityCullStats();
      console.table({
        gpuCullerOpaque: stats.gpuCullerOpaque,
        gpuCullerTranslucent: stats.gpuCullerTranslucent,
        hiZ: stats.hiZ,
        gpuSortKeys: stats.gpuSortKeys,
      });
      return stats;
    },

    /**
     * FORK-41 — toggle whether Hi-Z occlusion VISIBILITY is actually applied
     * (occluded commands dropped). Default OFF: the Hi-Z pyramid build +
     * OcclusionTest dispatch + readback still run when the density gate is
     * active (so `highDensityCull()` shows live `hiZ` stats), but the result
     * is inert (nothing dropped) until the OcclusionTest correctness gaps are
     * resolved + probe-verified (see DEFERRED_WORK FORK-41). Pass `true` to
     * enable command dropping for testing, `false` to restore the safe default.
     *
     * @param {boolean} [on=true] Whether to drop occluded commands.
     * @returns {boolean|null} The resulting enable state, or null if no WebGPU
     *   renderer is active.
     */
    hiZConsume(on = true) {
      const renderer = scene._alternateSceneRenderer;
      const ctor = renderer && renderer.constructor;
      if (!ctor || typeof ctor.setHiZConsumeEnabled !== "function") {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer — Hi-Z consume toggle unavailable",
        );
        return null;
      }
      ctor.setHiZConsumeEnabled(on === true);
      const state = ctor.hiZConsumeEnabled;
      console.log(
        `[CesiumDebug] Hi-Z occlusion consume (command drop) = ${state}`,
      );
      return state;
    },

    /**
     * NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) —
     * toggle whether the GPU-produced front-to-back sort order is applied
     * to the opaque command list. Default OFF: the keygen + bitonic sort
     * + readback always run when the density gate is active (so
     * `highDensityCull()` shows live `gpuSortKeys` stats), this only
     * toggles whether the resulting permutation reorders the commands.
     * Reordering opaque commands is output-invariant (depth test resolves
     * overlap), so this is byte-neutral for the final image — it exists
     * for A/B probes that confirm the consumer applies the exact
     * CPU-comparator order without a pixel change.
     *
     * @param {boolean} [on=true] Whether to apply the GPU sort order.
     * @returns {boolean|null} The resulting enable state, or null if no
     *   WebGPU renderer is active.
     */
    gpuSortConsume(on = true) {
      const renderer = scene._alternateSceneRenderer;
      const ctor = renderer && renderer.constructor;
      if (!ctor || typeof ctor.setGpuSortConsumeEnabled !== "function") {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer — GPU sort consume toggle unavailable",
        );
        return null;
      }
      ctor.setGpuSortConsumeEnabled(on === true);
      const state = ctor.gpuSortConsumeEnabled;
      console.log(`[CesiumDebug] GPU sort-order consume (reorder) = ${state}`);
      return state;
    },

    /**
     * Dump the globe surface bind-group cache stats
     * (NEW-GLOBE-BINDGROUP-CACHE, Batch 241). Healthy steady-state at a
     * fixed camera: `lastFrameCreates` ~0 with a high `hitRate`. A
     * sustained non-zero `lastFrameCreates` at a settled camera means
     * the ring-allocator offsets (group 0) or texture identities
     * (groups 1/2) are churning — see WEBGPU_DEBUGGING_LOG Batch 241.
     *
     * Counters are debug-pragma'd: production builds report 0 for
     * creates/hits (the cache still works; only the bookkeeping strips).
     */
    globeBindGroups() {
      const cache = globalThis.__webgpuGlobeBindGroupCache;
      if (!cache) {
        console.warn(
          "[CesiumDebug] No globe bind-group cache — WebGPU globe renderer not initialized",
        );
        return null;
      }
      const stats = cache.getStats();
      console.table(stats);
      return stats;
    },

    /**
     * Sample canvas pixels at key locations to check if anything renders.
     */
    canvasPixels() {
      const canvas = scene.canvas;
      if (!canvas) {
        console.warn("[CesiumDebug] No canvas");
        return;
      }
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const c = tmp.getContext("2d");
      c.drawImage(canvas, 0, 0);

      const points = [
        ["center", canvas.width / 2, canvas.height / 2],
        ["top-left", 100, 100],
        ["top-right", canvas.width - 100, 100],
        ["bottom-center", canvas.width / 2, canvas.height - 100],
        ["quarter", canvas.width / 4, canvas.height / 4],
      ];

      let nonBlack = 0;
      const fullData = c.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < fullData.length; i += 4) {
        if (fullData[i] > 0 || fullData[i + 1] > 0 || fullData[i + 2] > 0) {
          nonBlack++;
        }
      }

      const samples = {};
      for (const [name, x, y] of points) {
        const d = c.getImageData(x, y, 1, 1).data;
        samples[name] = `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${d[3]})`;
      }

      const result = {
        canvasSize: `${canvas.width}x${canvas.height}`,
        totalPixels: canvas.width * canvas.height,
        nonBlackPixels: nonBlack,
        coverage: `${((nonBlack / (canvas.width * canvas.height)) * 100).toFixed(2)}%`,
        samples,
      };
      console.table(result);
      console.table(samples);
      return result;
    },

    /**
     * Trigger the BUG-11 imagery probe (next 4 tile updates dumped).
     */
    logImageryProbe() {
      scene.debugShowImageryProbe = true;
      scene.requestRender();
      console.log(
        "[CesiumDebug] Imagery probe armed — next 4 tile updates will dump to console",
      );
    },

    /**
     * Install (or remove) the {@link DebugTileImageryProvider} overlay.
     *
     * Each visible tile gets a rich label: L/X/Y, projection class,
     * tile rectangle (lat/lon corners in degrees), and a red border on
     * tiles that straddle the Web Mercator ±85.0511° limit (the
     * polar-reprojection tiles per `IMAGERY_PROJECTION.md` Path B).
     *
     * Usage:
     *   CesiumDebug.tileDebugOverlay();                     // install with defaults
     *   CesiumDebug.tileDebugOverlay({ colorByLevel: true }); // tint by LOD
     *   CesiumDebug.tileDebugOverlay(null);                 // remove
     *
     * @param {object|null} [options] Constructor options forwarded to
     *   `DebugTileImageryProvider`, or `null` to remove the overlay.
     */
    tileDebugOverlay(options) {
      // Look up the previously installed overlay (if any) so we can
      // remove + re-add it idempotently. Stash the layer reference
      // on the scene so repeated calls don't pile up overlays.
      const tag = "_cesiumDebugTileOverlayLayer";
      const existing = scene[tag];
      if (existing) {
        scene.imageryLayers.remove(existing, true);
        scene[tag] = undefined;
      }
      if (options === null) {
        console.log("[CesiumDebug] tile-debug overlay removed");
        scene.requestRender();
        return;
      }
      // Dynamic import — the provider is in the engine package and is
      // exposed on `window.Cesium` once the dev viewer has loaded.
      const Ctor = (
        globalThis.Cesium ?? globalThis.viewer?.cesiumElement?.cesium
      )?.DebugTileImageryProvider;
      if (!Ctor) {
        console.warn(
          "[CesiumDebug] DebugTileImageryProvider not found on global Cesium; " +
            "build may not have it exported, or call this from a context " +
            "where Cesium is loaded.",
        );
        return;
      }
      const layer = scene.imageryLayers.addImageryProvider(
        new Ctor(options ?? {}),
      );
      scene[tag] = layer;
      scene.requestRender();
      console.log(
        "[CesiumDebug] tile-debug overlay installed. " +
          "Call CesiumDebug.tileDebugOverlay(null) to remove.",
      );
    },

    /**
     * Access the scene object directly.
     */
    get scene() {
      return scene;
    },

    /**
     * Access the context directly.
     */
    get context() {
      return scene._context;
    },

    /**
     * Access the WebGPU device directly (for advanced debugging).
     */
    get device() {
      return scene._context?._device;
    },
  };

  window.CesiumDebug = CesiumDebug;
  console.log(
    "%c[CesiumDebug] Debug tools loaded. Type CesiumDebug.help() for commands.",
    "color: #4CAF50; font-weight: bold",
  );
}

export default installCesiumDebug;
