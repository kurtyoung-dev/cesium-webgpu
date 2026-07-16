import { WebGPUSceneRenderer } from "../../../Source/Renderer/WebGPU/WebGPUSceneRenderer.js";
import { WebGPUContext } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";
import Pass from "../../../Source/Renderer/Pass.js";
import {
  normalizeTileIndirectMode,
  resolveTileIndirectPolicy,
} from "../../../Source/Renderer/WebGPU/WebGPUSceneRenderer3DTilePasses.js";
import { shouldAllocateWebGPUOIT } from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.js";

describe("Renderer/WebGPU unsafe default containment", function () {
  it("defaults a standalone WebGPUContext closed without lazy culler allocation", function () {
    // TypeScript's private constructor is an API guard; at runtime this focused
    // unit test can instantiate the pre-initialization state without requesting
    // an adapter/device or touching the network.
    const context = new WebGPUContext(document.createElement("canvas"), {});
    try {
      expect(context.gpuCullingHint).toBe("never");
      expect(context._gpuCuller).toBeNull();
      expect(context._gpuCullerTranslucent).toBeNull();
      expect(context._indirectDrawManager).toBeNull();

      // A device-shaped sentinel makes the culling hint, rather than the
      // missing-device guard, responsible for rejecting every lazy path.
      context._device = {};
      expect(context.gpuCuller).toBeNull();
      expect(context.gpuCullerTranslucent).toBeNull();
      expect(context.getGPUCullerForOpaqueFrustum(1)).toBeNull();
      expect(context.getGPUCullerForCascade(0)).toBeNull();
      context.warmUpHighDensityDispatchers();

      expect(context._gpuCullerInitializing).toBe(false);
      expect(context._gpuCullerTranslucentInitializing).toBe(false);
      expect(context._gpuCullerByFrustum.size).toBe(0);
      expect(context._gpuCullerByCascade.size).toBe(0);
      expect(context._indirectDrawManager).toBeNull();
    } finally {
      context._device = null;
      context.destroy();
    }
  });

  it("owns consume gates per renderer and defaults every consumer off", function () {
    const first = new WebGPUSceneRenderer();
    const second = new WebGPUSceneRenderer();

    expect(first.hiZConsumeEnabled).toBe(false);
    expect(first.gpuSortConsumeMode).toBe("never");
    expect(first.gpuSortConsumeEnabled).toBe(false);
    expect(first.webgpuOITEnabled).toBe(false);
    expect(first._oit).toBeNull();

    first.setHiZConsumeEnabled(true);
    first.setGpuSortConsumeMode("always");
    first.setWebGPUOITEnabled(true);

    expect(first.hiZConsumeEnabled).toBe(true);
    expect(first.gpuSortConsumeEnabled).toBe(true);
    expect(first.webgpuOITEnabled).toBe(true);
    expect(second.hiZConsumeEnabled).toBe(false);
    expect(second.gpuSortConsumeMode).toBe("never");
    expect(second.webgpuOITEnabled).toBe(false);
  });

  it("keeps HiZ and GPU-sort results inert until explicitly forced", function () {
    const renderer = new WebGPUSceneRenderer();
    const firstCommand = { id: "first" };
    const secondCommand = { id: "second" };
    const commands = [firstCommand, secondCommand];

    renderer._lastHiZVisibility = {
      flags: new Uint32Array([1, 0]),
      count: 2,
    };
    expect(renderer._filterByHiZVisibility(commands, 2)).toBe(commands);
    renderer.setHiZConsumeEnabled(true);
    const filtered = renderer._filterByHiZVisibility(commands, 2);
    expect(filtered).toEqual([firstCommand]);

    renderer._lastSortedIndices = {
      indices: new Uint32Array([1, 0]),
      count: 2,
      originalCount: 2,
      compactedToOriginal: new Uint32Array([0, 1]),
      skipped: [],
    };
    renderer.setGpuSortConsumeMode("never");
    expect(renderer._applySortedOrder(commands, 2)).toBe(commands);
    renderer.setGpuSortConsumeMode("always");
    expect(renderer._applySortedOrder(commands, 2)).toEqual([
      secondCommand,
      firstCommand,
    ]);
  });

  it("does not produce GPU sort keys while the sort consumer is disabled", function () {
    const renderer = new WebGPUSceneRenderer();
    const commandCount = 6000;
    const opaqueCommands = Array.from({ length: commandCount }, function () {
      return {};
    });
    const commands = [];
    const indices = [];
    commands[Pass.OPAQUE] = opaqueCommands;
    indices[Pass.OPAQUE] = commandCount;
    const frustumCommands = { commands, indices };
    const scene = {
      gpuCullingHint: "auto",
      _view: { frustumCommandsList: [frustumCommands] },
    };
    const context = {
      uniformState: { updatePass: function () {} },
      endCurrentRenderPass: function () {},
    };
    const sortDispatch = spyOn(renderer, "_dispatchGPUSortKeys");
    spyOn(renderer, "_dispatchHiZForNextFrame");
    spyOn(renderer, "_resumeScenePass");

    renderer._executeOpaquePass(frustumCommands, {
      scene,
      context,
      passState: {},
      picking: false,
    });

    expect(renderer.gpuSortConsumeMode).toBe("never");
    expect(sortDispatch).not.toHaveBeenCalled();
  });

  it("requires the explicit always mode for translucent GPU culling", function () {
    const renderer = new WebGPUSceneRenderer();
    const commands = Array.from({ length: 384 }, function () {
      return {};
    });
    const filtered = [commands[0]];
    const cullSpy = spyOn(
      renderer,
      "gpuCullCommandsForTranslucent",
    ).and.returnValue(filtered);
    const scene = {
      gpuCullingHint: "auto",
      _frameState: {
        cullingVolume: {
          planes: [{ x: 1, y: 0, z: 0, w: 1 }],
        },
      },
    };
    const config = { picking: false, scene: scene, context: {} };

    const automatic = renderer._maybeGPUCullTranslucent(
      commands,
      commands.length,
      config,
    );
    expect(automatic.commands).toBe(commands);
    expect(cullSpy).not.toHaveBeenCalled();

    scene.gpuCullingHint = "always";
    const forced = renderer._maybeGPUCullTranslucent(
      commands,
      commands.length,
      config,
    );
    expect(cullSpy).toHaveBeenCalled();
    expect(forced.commands).toBe(filtered);
    expect(forced.count).toBe(1);
  });

  it("maps the legacy tile-indirect boolean closed and avoids lazy manager reads", function () {
    expect(normalizeTileIndirectMode(undefined)).toBe("never");
    expect(normalizeTileIndirectMode(false)).toBe("never");
    expect(normalizeTileIndirectMode(true)).toBe("always");
    expect(normalizeTileIndirectMode("auto")).toBe("auto");

    let managerReads = 0;
    const context = {
      useIndirectDrawForTiles: false,
      device: {},
      currentRenderPassEncoder: {},
    };
    Object.defineProperty(context, "indirectDrawManager", {
      get: function () {
        managerReads++;
        return {};
      },
    });

    const disabled = resolveTileIndirectPolicy(context, 10_000);
    expect(disabled.requestedMode).toBe("never");
    expect(disabled.requested).toBe(false);
    expect(disabled.active).toBe(false);
    expect(managerReads).toBe(0);

    context.useIndirectDrawForTiles = "auto";
    const belowThreshold = resolveTileIndirectPolicy(context, 31);
    expect(belowThreshold.requested).toBe(true);
    expect(belowThreshold.active).toBe(false);
    expect(belowThreshold.fallbackReason).toBe("below-threshold");
    expect(managerReads).toBe(0);

    context.useIndirectDrawForTiles = true;
    const forced = resolveTileIndirectPolicy(context, 1);
    expect(forced.requestedMode).toBe("always");
    expect(forced.capable).toBe(true);
    expect(forced.active).toBe(true);
    expect(managerReads).toBe(1);
  });

  it("does not allocate WebGPU OIT for a Scene request without the safety gate", function () {
    expect(shouldAllocateWebGPUOIT(true, false)).toBe(false);
    expect(shouldAllocateWebGPUOIT(false, true)).toBe(false);
    expect(shouldAllocateWebGPUOIT(true, true)).toBe(true);
  });

  it("reports requested, capable, active, and fallback state separately", function () {
    const renderer = new WebGPUSceneRenderer();
    renderer._lastOITRequested = true;

    const contained = renderer.getContainmentStats();
    expect(contained.gpuCullerOpaque.requestedMode).toBe("never");
    expect(contained.gpuCullerOpaque.requested).toBe(false);
    expect(contained.gpuCullerOpaque.active).toBe(false);
    expect(contained.gpuCullerOpaque.fallbackReason).toBe("not-requested");
    expect(contained.hiZ.requested).toBe(false);
    expect(contained.gpuSortKeys.requestedMode).toBe("never");
    expect(contained.tileIndirect.requested).toBe(false);
    expect(contained.webgpuOIT.requested).toBe(true);
    expect(contained.webgpuOIT.capable).toBe(false);
    expect(contained.webgpuOIT.active).toBe(false);
    expect(contained.webgpuOIT.fallbackReason).toBe("contained-unsafe-path");
  });
});
