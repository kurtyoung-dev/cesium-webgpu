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
║  CesiumDebug.gpuPassCost(t/f)  — GPU per-pass cost (timestamp) ║
║  CesiumDebug.highDensityCull() — gpuCuller/HiZ/sort-keys stats ║
║  CesiumDebug.globeBindGroups() — globe bind-group cache stats ║
║  CesiumDebug.cacheStats()      — pipeline + bind-group cache counters ║
║  CesiumDebug.cloudStats(t/f)   — cloud observability + CPU stage timing ║
║  CesiumDebug.cloudReconstructionAttachments(t/f) — C13-09 attachment set ║
║  CesiumDebug.webgpuOIT(t/f)    — WebGPU OIT containment gate (FAR-003) ║
║  CesiumDebug.attachmentDemand(t/f) — scene-FB attachment demand record ║
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
     * feature to be enabled (gated by `WebGPUFeatureFlags`).
     *
     * Unlike CPU pass cost, GPU timings show the actual shader-execution
     * cost on the device — useful for deciding which passes are GPU-bound
     * (lower values for compute or simpler shaders, higher for fillrate-
     * bound passes like Bloom or AO).
     *
     * Usage:
     *   CesiumDebug.gpuPassCost(true)   // enable + reset
     *   CesiumDebug.gpuPassCost()       // dump rolling-window stats
     *   CesiumDebug.gpuPassCost(false)  // disable
     */
    gpuPassCost(enabled) {
      const ctx = scene._context;
      if (!ctx?.isWebGPU) {
        console.warn("[CesiumDebug] GPU pass profiler is WebGPU-only");
        return;
      }
      const manager = ctx.performanceManager;
      if (typeof enabled === "boolean") {
        manager.config.timestampProfiling = enabled;
        if (!enabled) {
          console.log("[CesiumDebug] GPU pass profiling disabled");
          return;
        }
      }
      if (!manager.config.timestampProfiling) {
        console.warn(
          "[CesiumDebug] GPU pass profiling is OFF — call gpuPassCost(true) first",
        );
        return;
      }
      const profiler = ctx.timestampProfiler;
      if (!profiler) {
        manager.config.timestampProfiling = false;
        console.warn(
          "[CesiumDebug] timestamp-query feature not available on this adapter",
        );
        return;
      }
      if (enabled === true) {
        profiler.reset();
        scene.requestRender();
        console.log("[CesiumDebug] GPU pass profiling enabled and reset");
      }
      const results = profiler.getResults();
      if (!results.enabled) {
        console.warn(
          "[CesiumDebug] GPU pass profiler is not active despite being requested",
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
      if (rows.length === 0) {
        console.warn(
          "[CesiumDebug] GPU pass profiling is active but has no resolved pass samples yet",
        );
      }
      console.log(
        `[CesiumDebug] GPU pass cost (frame=${results.frameMs.toFixed(3)}ms ` +
          `avg=${results.frameAvgMs.toFixed(3)}ms frames=${results.frameCount}):`,
      );
      console.table(rows);
      // C11-140 — a per-pass table is only trustworthy if the samples behind it
      // are accounted for. Surface the two invariants next to the numbers so an
      // unbalanced ledger or an overlapping-pass double-count is visible at the
      // point of reading, not only in the probe artifact.
      if (!results.sampleLedgerBalanced) {
        console.error(
          `[CesiumDebug] GPU sample ledger does NOT close: ${results.unaccountedSampleCount} of ` +
            `${results.attemptedFrameCount} attempts have no recorded outcome — these timings under-report`,
        );
      }
      console.log(
        `[CesiumDebug] GPU sample accounting: covered=${results.coveredMs.toFixed(3)}ms ` +
          `unprofiled=${results.unprofiledMs.toFixed(3)}ms overlap=${results.overlapMs.toFixed(3)}ms ` +
          `coverage=${results.coverageRatio === null ? "n/a" : `${(results.coverageRatio * 100).toFixed(1)}%`} ` +
          `| sampled=${results.frameCount} skipped=${results.readbackSkipCount} ` +
          `empty=${results.emptyFrameCount} failed=${results.failedReadbackCount} ` +
          `lost=${results.lostSampleCount} pending=${results.pendingReadbackCount}`,
      );
      return results;
    },

    /**
     * C9-09-ATTACHMENT-DEMAND-REGISTRY — dump the canonical per-frame
     * attachment-demand record and the ACTUAL measured scene-FB topology.
     * WebGPU-only. Pass a boolean to set the conservative `forceSceneMRT`
     * switch (its default `true` keeps today's always-MRT behavior until
     * C9-10 lands the demand-driven flip).
     *
     * Usage:
     *   CesiumDebug.attachmentDemand()        // dump current record + actual
     *   CesiumDebug.attachmentDemand(false)   // BLOCKED until C9-10 (refused, no-op)
     *   CesiumDebug.attachmentDemand(true)    // force full MRT (default)
     */
    attachmentDemand(force) {
      const ctx = scene._context;
      if (!ctx?.isWebGPU) {
        console.warn("[CesiumDebug] attachmentDemand is WebGPU-only");
        return;
      }
      // C9-AUDIT-P1-SWEEP (Batch 684): REFUSE the mid-session demand-driven
      // MRT topology flip. The C9-10 block analysis proved a live
      // `forceSceneMRT=false` flip unsafe until the 31-renderer topology-keyed
      // pipeline-cache audit lands — a stale MRT-keyed pipeline replayed into
      // a single-target pass corrupts the scene FB. Permanent warn (real
      // hazard, no pragma); context state is left unchanged.
      if (force === false) {
        console.warn(
          "[CesiumDebug] attachmentDemand(false) is BLOCKED until C9-10 lands: " +
            "the 31-renderer topology-keyed cache audit. Refusing the " +
            "demand-driven MRT topology flip; context.forceSceneMRT unchanged.",
        );
        return;
      }
      if (force === true) {
        ctx.forceSceneMRT = true;
        scene.requestRender();
        console.log(
          "[CesiumDebug] context.forceSceneMRT set to true (takes effect next frame)",
        );
      }
      if (typeof ctx.getAttachmentDemandStats !== "function") {
        console.warn("[CesiumDebug] attachment-demand registry not available");
        return;
      }
      const stats = ctx.getAttachmentDemandStats();
      if (!stats) {
        console.warn(
          "[CesiumDebug] no attachment-demand record yet — render one frame first",
        );
        return;
      }
      console.log(
        `[CesiumDebug] attachment demand: topology=${stats.record.topology} ` +
          `gbufferDemanded=${stats.record.gbufferDemanded} ` +
          `forceSceneMRT=${stats.forceSceneMRT} ` +
          `recordMatchesActual=${stats.recordMatchesActual}`,
      );
      console.table(stats.record.gbufferReaders);
      console.table(stats.actual);
      return stats;
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
      if (!renderer || typeof renderer.setHiZConsumeEnabled !== "function") {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer — Hi-Z consume toggle unavailable",
        );
        return null;
      }
      renderer.setHiZConsumeEnabled(on === true);
      const state = renderer.hiZConsumeEnabled;
      console.log(
        `[CesiumDebug] Hi-Z occlusion consume (command drop) = ${state}`,
      );
      return state;
    },

    /**
     * NEW-GPU-SORT-PIPELINE Phase 3 (C4-GPU-SORT-PIPELINE-PHASE3) —
     * force-toggle whether the GPU-produced front-to-back sort order is
     * applied to the opaque command list. `true` maps to the `"always"`
     * consumer mode, `false` to `"never"` (the off-gate). The keygen +
     * bitonic sort + readback always run when the density gate is active
     * (so `highDensityCull()` shows live `gpuSortKeys` stats); this only
     * toggles whether the resulting permutation reorders the commands.
     * Reordering opaque commands is output-invariant (depth test resolves
     * overlap), so this is byte-neutral for the final image — it exists
     * for A/B probes that confirm the consumer applies the exact
     * CPU-comparator order without a pixel change.
     *
     * The contained production default is `"never"`; use
     * {@link CesiumDebug.gpuSortConsumeMode} to explicitly select
     * `"auto"` for threshold characterization.
     *
     * @param {boolean} [on=true] Whether to apply the GPU sort order.
     * @returns {boolean|null} The resulting enable state, or null if no
     *   WebGPU renderer is active.
     */
    gpuSortConsume(on = true) {
      const renderer = scene._alternateSceneRenderer;
      if (
        !renderer ||
        typeof renderer.setGpuSortConsumeEnabled !== "function"
      ) {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer — GPU sort consume toggle unavailable",
        );
        return null;
      }
      renderer.setGpuSortConsumeEnabled(on === true);
      const state = renderer.gpuSortConsumeEnabled;
      console.log(`[CesiumDebug] GPU sort-order consume (reorder) = ${state}`);
      return state;
    },

    /**
     * NS-GPU-SORT-NO-SCENE-WIRING — set the consumer activation MODE for
     * the GPU front-to-back opaque sort. `"never"` is the contained
     * default; `"auto"` applies whenever the opaque-command-count gate is
     * active and `"always"` force-applies when a valid result exists.
     *
     * @param {"auto"|"always"|"never"} [mode="never"] The consumer mode.
     * @returns {string|null} The resulting mode, or null if no WebGPU
     *   renderer is active.
     */
    gpuSortConsumeMode(mode = "never") {
      const renderer = scene._alternateSceneRenderer;
      if (!renderer || typeof renderer.setGpuSortConsumeMode !== "function") {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer — GPU sort consume mode unavailable",
        );
        return null;
      }
      renderer.setGpuSortConsumeMode(mode);
      const state = renderer.gpuSortConsumeMode;
      console.log(`[CesiumDebug] GPU sort-order consume mode = ${state}`);
      return state;
    },

    /**
     * FAR-003 — read or toggle the WebGPU MRT OIT safety-containment gate
     * (`_webgpuOITEnabled`, contained production default `false`). The
     * public `scene.orderIndependentTranslucency` option remains a REQUEST;
     * this renderer-owned gate controls whether the contained WebGPU MRT
     * implementation may allocate or execute. While the gate is off,
     * translucency uses the complete alpha-blend fallback.
     *
     * Call with no argument to inspect requested-vs-active state without
     * changing anything. A toggle takes effect on the next rendered frame
     * (`active` reflects the most recent frame).
     *
     * @param {boolean} [enable] New gate state; omit to just report.
     * @returns {object|null} The webgpuOIT containment status
     *   (`{ safetyGateEnabled, requested, capable, active, fallbackReason }`),
     *   or null if no WebGPU renderer is active.
     */
    webgpuOIT(enable) {
      const renderer = scene._alternateSceneRenderer;
      if (!renderer || typeof renderer.setWebGPUOITEnabled !== "function") {
        console.warn(
          "[CesiumDebug] No WebGPU scene renderer — OIT containment gate unavailable",
        );
        return null;
      }
      if (enable !== undefined) {
        renderer.setWebGPUOITEnabled(enable === true);
      }
      const status =
        typeof renderer.getContainmentStats === "function"
          ? renderer.getContainmentStats().webgpuOIT
          : { safetyGateEnabled: renderer.webgpuOITEnabled };
      const fallback = status.fallbackReason
        ? `, fallback=${status.fallbackReason}`
        : "";
      console.log(
        `[CesiumDebug] WebGPU OIT containment gate = ${status.safetyGateEnabled} ` +
          `(requested=${status.requested}, active=${status.active}${fallback})`,
      );
      return status;
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
     * C11-174 — dump the central render-pipeline cache and the
     * post-process bind-group cache counters (hits/misses/hitRate).
     * Pure exposure of bookkeeping the caches already maintain on their
     * lookup paths — calling this adds no per-frame work.
     *
     * Healthy steady state: high hitRate on every row. A near-zero
     * bind-group hitRate is the Batch-717 churn shape — resource
     * identities (texture views, buffers) recreated every frame without
     * a matching cache invalidation.
     *
     * Usage:
     *   CesiumDebug.cacheStats()
     */
    cacheStats() {
      const ctx = scene._context;
      if (!ctx?.isWebGPU || typeof ctx.getRendererStatistics !== "function") {
        console.warn("[CesiumDebug] Cache stats are WebGPU-only");
        return null;
      }
      const stats = ctx.getRendererStatistics();
      const pipeline = stats.pipelineCache;
      const bindGroups = stats.bindGroupCaches;
      if (!pipeline && !bindGroups) {
        console.warn(
          "[CesiumDebug] No cache statistics yet — render at least one frame first",
        );
        return null;
      }
      const formatRate = (rate) =>
        Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : "n/a";
      const rows = [];
      if (pipeline && pipeline.error === undefined) {
        rows.push({
          cache: "renderPipeline",
          hits: pipeline.hits,
          misses: pipeline.misses,
          hitRate: formatRate(pipeline.hitRate),
          size: pipeline.size,
          evicted: pipeline.evicted,
          // wrongModuleHits: aliased hits served with a DIFFERENT shader
          // module than requested. Aliasing RAISES hitRate, so this counter
          // is the only self-diagnostic for key collisions; nonzero = a
          // key-construction defect.
          wrongModuleHits: pipeline.wrongModuleHits ?? 0,
          detail: `created=${pipeline.created} pending=${pipeline.pending} max=${pipeline.maxSize}`,
        });
        if ((pipeline.wrongModuleHits ?? 0) > 0) {
          console.error(
            `[CesiumDebug] renderPipeline cache served ${pipeline.wrongModuleHits} ` +
              "WRONG-MODULE hits — pipeline cache key collision (aliasing). " +
              "Inspect listPipelineVariants() for same-key different-module entries.",
          );
        }
      }
      if (bindGroups && bindGroups.error === undefined) {
        for (const [name, bg] of Object.entries(bindGroups)) {
          if (!bg) {
            continue; // effect not added to the pipeline
          }
          rows.push({
            cache: `bindGroups:${name}`,
            hits: bg.hits,
            misses: bg.misses,
            hitRate: formatRate(bg.hitRate),
            size: bg.size,
            evicted: bg.evictions,
            detail: `invalidations=${bg.invalidations}`,
          });
        }
      }
      if (rows.length === 0) {
        console.warn(
          "[CesiumDebug] Caches not initialized yet — render at least one frame first",
        );
        return null;
      }
      console.table(rows);
      return {
        pipelineCache: pipeline ?? null,
        bindGroupCaches: bindGroups ?? null,
      };
    },

    /**
     * C13-02 — cloud CPU/GPU observability and temporal-cost counters.
     *
     * Read-only with no argument. Pass `true`/`false` to turn CPU STAGE TIMING
     * on or off: it is off by default because a `performance.now()` pair
     * straddling each stage is observable work on the shipped path, and
     * C13-02 requires the instrumentation to be removable without changing the
     * render result. Toggling clears the accumulated stage statistics so a
     * later read cannot present numbers from a differently-configured run.
     *
     * The counters themselves (target sizes, dispatched pixels, pass counts,
     * history accept/reject/reset, weather cache hits/misses/uploads/bytes)
     * are always live — they are bookkeeping the renderer already pays for.
     *
     * `gpu` is present only when the adapter supports `timestamp-query` AND a
     * readback has completed; it is the UNION of the cloud passes' GPU
     * intervals, not their sum, so `cloudOverlapMs > 0` is a real finding
     * (two cloud passes overlapped) rather than a rounding detail.
     *
     * Usage:
     *   CesiumDebug.cloudStats()        // read
     *   CesiumDebug.cloudStats(true)    // enable CPU stage timing
     */
    cloudStats(enableCpuTiming) {
      const ctx = scene._context;
      if (!ctx?.isWebGPU || typeof ctx.getRendererStatistics !== "function") {
        console.warn("[CesiumDebug] Cloud statistics are WebGPU-only");
        return null;
      }
      if (typeof enableCpuTiming === "boolean") {
        const stagesOwner = ctx._cloudCache?.cpuStages;
        if (!stagesOwner) {
          console.warn(
            "[CesiumDebug] Cloud renderer has not run yet — enable clouds and render a frame first",
          );
          return null;
        }
        stagesOwner.setEnabled(enableCpuTiming);
      }
      const clouds = ctx.getRendererStatistics().volumetricClouds;
      if (!clouds) {
        console.warn(
          "[CesiumDebug] No cloud statistics yet — enable the volumetric cloud deck and render a frame first",
        );
        return null;
      }
      if (clouds.error !== undefined) {
        console.error(`[CesiumDebug] Cloud statistics failed: ${clouds.error}`);
        return clouds;
      }
      console.table([
        {
          lane: "raymarch",
          size: `${clouds.raymarch.width}x${clouds.raymarch.height}`,
          pixels: clouds.raymarch.pixelsDispatched,
          detail: `maxSteps=${clouds.raymarch.maxSteps} lightSteps=${clouds.raymarch.lightSteps} halfRes=${clouds.raymarch.halfResActive}`,
        },
        {
          lane: "reconstruction",
          size: `${clouds.reconstruction.resolveWidth}x${clouds.reconstruction.resolveHeight}`,
          pixels: clouds.reconstruction.resolvePixels,
          detail: `accepted=${clouds.reconstruction.historyAccepted} rejected=${clouds.reconstruction.historyRejected} reset=${clouds.reconstruction.historyReset} gen=${clouds.reconstruction.lifetime.generation}`,
        },
        {
          // C13-09 — zeros here are the DEFAULT state (the set is opt-in), not
          // a missing measurement. CesiumDebug.cloudReconstructionAttachments()
          // prints the per-target contract.
          lane: "attachments",
          size: `${clouds.reconstruction.attachments.width}x${clouds.reconstruction.attachments.height}`,
          pixels: clouds.reconstruction.attachments.pixelsDispatched,
          detail: `produced=${clouds.reconstruction.attachments.produced} targets=${clouds.reconstruction.attachments.targetCount} gen=${clouds.reconstruction.attachments.generation} liveBytes=${clouds.reconstruction.attachments.liveBytes}`,
        },
        {
          lane: "shadow",
          size: `${clouds.shadow.size} / atlas ${clouds.shadow.cascadeSize}x${clouds.shadow.cascadeCount}`,
          pixels: clouds.shadow.size * clouds.shadow.size,
          detail: `passes=${clouds.shadow.passCount}`,
        },
        {
          lane: "weather",
          size: `${clouds.weather.liveBytes} B live`,
          pixels: clouds.weather.uploadBytes,
          detail: `hits=${clouds.weather.cacheHits} misses=${clouds.weather.cacheMisses} uploads=${clouds.weather.uploads}`,
        },
        {
          lane: "passes",
          size: `${clouds.passCount} this frame`,
          pixels: clouds.frames,
          detail: `culled=${clouds.culledFrames}`,
        },
      ]);
      if (clouds.cpu.enabled === true) {
        console.table(clouds.cpu.stages);
      } else {
        console.log(
          "[CesiumDebug] CPU stage timing is OFF (default). CesiumDebug.cloudStats(true) to enable.",
        );
      }
      if (clouds.gpu) {
        console.table({
          clouds: clouds.gpu.clouds,
          environment: clouds.gpu.environment,
        });
        if (clouds.gpu.clouds.cloudOverlapMs > 0) {
          console.warn(
            `[CesiumDebug] Cloud passes OVERLAPPED in GPU time by ${clouds.gpu.clouds.cloudOverlapMs.toFixed(4)} ms — ` +
              "the naive sum of their durations would double-count that span.",
          );
        }
      } else {
        console.log(
          "[CesiumDebug] No GPU timestamps yet — CesiumDebug.gpuPassCost(true), then render.",
        );
      }
      return clouds;
    },

    /**
     * C13-09 — read or toggle the cloud RECONSTRUCTION ATTACHMENT set (front /
     * transmittance-weighted depth, screen-space velocity, depth+coverage
     * moments).
     *
     * DEFAULT OFF, and that is the shipped contract: with it off nothing is
     * allocated and no pass is encoded, so the cloud lane is identical in
     * pixels AND in cost. With it on the producer runs and the counters
     * report, but NOTHING READS THE SET — the consumers are C13-10 (true
     * 1/16-rate current-frame march) and C13-12 (motion/depth rejection,
     * variance clipping, reactive history, wind-aware reprojection,
     * disocclusion). So the composite is byte-identical either way, which is
     * exactly what makes this safe to leave on while measuring.
     *
     * The producer needs the half-resolution march target, so a tier that
     * resolves `renderResScale === 1` (cinematic, or the `cloudQuality !== 64`
     * escape hatch) produces nothing even when enabled. Set
     * `cloudVolumetricQuality` to "low" or "medium" to exercise it.
     *
     * Usage:
     *   CesiumDebug.cloudReconstructionAttachments()      // read
     *   CesiumDebug.cloudReconstructionAttachments(true)  // enable
     *
     * @param {boolean} [enabled] Omit to read; pass a boolean to set.
     * @returns {object|null} The attachment block of the cloud snapshot.
     */
    cloudReconstructionAttachments(enabled) {
      const ctx = scene._context;
      if (!ctx?.isWebGPU || typeof ctx.getRendererStatistics !== "function") {
        console.warn(
          "[CesiumDebug] Cloud reconstruction attachments are WebGPU-only",
        );
        return null;
      }
      const cache = ctx._cloudCache;
      if (!cache) {
        console.warn(
          "[CesiumDebug] Cloud renderer has not run yet — enable a VOLUMETRIC CloudCollection and render a frame first",
        );
        return null;
      }
      if (typeof enabled === "boolean") {
        cache.attachmentsEnabled = enabled;
        console.log(
          `[CesiumDebug] Cloud reconstruction attachments ${
            enabled ? "ENABLED" : "DISABLED"
          } — the composite is unchanged either way (no consumer until C13-10/12).`,
        );
      }
      const clouds = ctx.getRendererStatistics().volumetricClouds;
      const attachments = clouds?.reconstruction?.attachments;
      if (!attachments) {
        console.warn("[CesiumDebug] No cloud statistics yet — render a frame");
        return null;
      }
      console.table(attachments.contract);
      console.table([
        {
          produced: attachments.produced,
          size: `${attachments.width}x${attachments.height}`,
          pixels: attachments.pixelsDispatched,
          targets: attachments.targetCount,
          generation: attachments.generation,
          liveBytes: attachments.liveBytes,
        },
      ]);
      if (!attachments.produced && cache.attachmentsEnabled) {
        console.log(
          "[CesiumDebug] Enabled but not produced — the producer needs the half-res march target (cloudVolumetricQuality 'low'/'medium') and a perspective, non-morphing frame.",
        );
      }
      return attachments;
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
