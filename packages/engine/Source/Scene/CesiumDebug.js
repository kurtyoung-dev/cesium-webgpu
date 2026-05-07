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
╚══════════════════════════════════════════════════════╝
      `);
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
      if (webglDepthViewStage) {
        webglDepthViewStage.enabled = false;
      }
      scene.requestRender();
      console.log("[CesiumDebug] Depth buffer visualization OFF");
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
