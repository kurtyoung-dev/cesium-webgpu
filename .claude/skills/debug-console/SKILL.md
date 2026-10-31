---
name: debug-console
description: CesiumDebug console command reference, and how to record a fixed bug in WEBGPU_DEBUGGING_LOG.md. Read when debugging rendering or documenting a fix.
---

# Debug Console Commands

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

Quick reference. **Full procedures + probe inventory: [migration_doc/DEBUGGING_GUIDE.md](../../../migration_doc/DEBUGGING_GUIDE.md).**

- CesiumDebug.help() — list all commands
- CesiumDebug.snapshot() — full debug snapshot
- CesiumDebug.showDepth() — depth buffer as grayscale
- CesiumDebug.showWireframe() — globe wireframe overlay
- CesiumDebug.showFrustums() — colorize frustum splits
- CesiumDebug.showCommands() — command count overlay
- CesiumDebug.toggleFPS() — FPS counter
- CesiumDebug.pipelineStatus() — shader/pipeline/device health check
- CesiumDebug.postProcess() — post-process pipeline state table
- CesiumDebug.cpuPassCost(t/f) — per-pass CPU profile (R-7a)
- CesiumDebug.gpuPassCost(t/f) — enable/reset, dump, or disable per-pass GPU timing
- CesiumDebug.highDensityCull() — gpuCuller / HiZ / sort-keys stats
- CesiumDebug.globeBindGroups() — globe bind-group cache stats (Batch 241)
- CesiumDebug.cacheStats() — pipeline + bind-group cache counters (Batch 741)
- CesiumDebug.webgpuOIT(on?) — read/toggle the FAR-003 WebGPU MRT OIT containment flag (requested-vs-active)
- CesiumDebug.canvasPixels() — sample canvas pixel data
- CesiumDebug.logImageryProbe() — dump next 4 tile updates
- CesiumDebug.tileDebugOverlay() — overlay rich per-tile labels (L/X/Y, rectangle, projection, Mercator-limit edge)
- CesiumDebug.globeFragmentDebug(name) — visualize one stage of the globe FS (mode table in the guide)
- CesiumDebug.scene / .context / .device — direct accessors

## Debugging Documentation

When fixing bugs, document in `migration_doc/WEBGPU_DEBUGGING_LOG.md` (the chronological bug log; search it before debugging a new artifact):

- Bug number (Session.Bug format)
- File(s) affected
- Root cause description
- Fix applied
- Files modified
