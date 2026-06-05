import {
  DerivedCommandType,
  WebGPUDerivedCommand,
} from "../../../Source/Renderer/WebGPU/WebGPUDerivedCommand.js";

// ── Test surface ────────────────────────────────────────────────────
//
// WebGPUDerivedCommand is almost entirely device-free. Its five static
// factory methods (createDepthOnlyDerivedCommand, createLogDepthCommand,
// createPickDerivedCommand, createHDRDerivedCommand,
// createShadowDerivedCommand) only CLONE the supplied draw command (via
// command.clone() when present, otherwise Object.assign({}, command)) and
// stamp plain JS properties onto the clone — they never touch a
// GPUDevice/queue and never create a pipeline. The static pipeline/shader
// caches are plain Maps mutated only by clearCache(); getCacheStats()
// reads their .size.
//
// These specs cover the pure surface:
//   - the DerivedCommandType enum string values
//   - each factory's property stamping (copied verbatim from the source)
//   - the result-reuse contract (passing a result object back populates
//     and returns the SAME object)
//   - the clone contract (command.clone() is preferred; without it the
//     base command is shallow-copied and left unmutated)
//   - clearCache() / getCacheStats() accounting on the static caches
//
// No path here calls device.create* — there is nothing device-bound to
// skip; the entire exercised surface is deterministic without a GPU.

// A minimal draw-command stub. When `withClone` is true it exposes a
// clone() that returns a fresh shallow copy (the real
// WebGPUDrawCommand.clone() contract the factories rely on); otherwise
// the factories fall back to Object.assign.
function makeCommand(withClone) {
  const base = { _flag: "base" };
  if (withClone) {
    base.clone = function () {
      const copy = Object.assign({}, base);
      copy._cloned = true;
      return copy;
    };
  }
  return base;
}

describe("Renderer/WebGPU/WebGPUDerivedCommand", function () {
  beforeEach(function () {
    // The pipeline/shader caches are module-static. Reset between specs
    // so cache-accounting assertions are order-independent.
    WebGPUDerivedCommand.clearCache();
  });

  afterAll(function () {
    WebGPUDerivedCommand.clearCache();
  });

  describe("DerivedCommandType enum", function () {
    it("exposes the documented string values", function () {
      expect(DerivedCommandType.LOG_DEPTH).toBe("logDepth");
      expect(DerivedCommandType.DEPTH_ONLY).toBe("depthOnly");
      expect(DerivedCommandType.PICK).toBe("pick");
      expect(DerivedCommandType.HDR).toBe("hdr");
      expect(DerivedCommandType.SHADOW).toBe("shadow");
    });

    it("has exactly five members", function () {
      expect(Object.keys(DerivedCommandType).length).toBe(5);
    });
  });

  describe("WebGPUDerivedCommand exports", function () {
    it("is defined with the five static factory methods", function () {
      expect(WebGPUDerivedCommand).toBeDefined();
      expect(typeof WebGPUDerivedCommand.createDepthOnlyDerivedCommand).toBe(
        "function",
      );
      expect(typeof WebGPUDerivedCommand.createLogDepthCommand).toBe(
        "function",
      );
      expect(typeof WebGPUDerivedCommand.createPickDerivedCommand).toBe(
        "function",
      );
      expect(typeof WebGPUDerivedCommand.createHDRDerivedCommand).toBe(
        "function",
      );
      expect(typeof WebGPUDerivedCommand.createShadowDerivedCommand).toBe(
        "function",
      );
    });
  });

  describe("createDepthOnlyDerivedCommand", function () {
    it("stamps the depth-only pipeline overrides on the clone", function () {
      const command = makeCommand(true);
      const result =
        WebGPUDerivedCommand.createDepthOnlyDerivedCommand(command);
      expect(result.command._depthOnly).toBe(true);
      expect(result.command._colorWriteMask).toBe(0);
      expect(result.command._depthWriteEnabled).toBe(true);
    });

    it("clones the command (does not mutate the base) when clone() exists", function () {
      const command = makeCommand(true);
      const result =
        WebGPUDerivedCommand.createDepthOnlyDerivedCommand(command);
      expect(result.command._cloned).toBe(true);
      expect(command._depthOnly).toBeUndefined();
    });

    it("falls back to Object.assign when the command has no clone()", function () {
      const command = makeCommand(false);
      const result =
        WebGPUDerivedCommand.createDepthOnlyDerivedCommand(command);
      expect(result.command).not.toBe(command);
      expect(result.command._flag).toBe("base");
      expect(result.command._depthOnly).toBe(true);
      // The shallow copy must not mutate the original command object.
      expect(command._depthOnly).toBeUndefined();
    });

    it("reuses and returns the supplied result object", function () {
      const command = makeCommand(true);
      const reused = { command: undefined };
      const result = WebGPUDerivedCommand.createDepthOnlyDerivedCommand(
        command,
        reused,
      );
      expect(result).toBe(reused);
      expect(reused.command._depthOnly).toBe(true);
    });
  });

  describe("createLogDepthCommand", function () {
    it("marks the clone for log-depth rendering", function () {
      const command = makeCommand(true);
      const result = WebGPUDerivedCommand.createLogDepthCommand(command);
      expect(result.command._logDepth).toBe(true);
    });

    it("does not set depth-only or pick overrides", function () {
      const command = makeCommand(true);
      const result = WebGPUDerivedCommand.createLogDepthCommand(command);
      expect(result.command._depthOnly).toBeUndefined();
      expect(result.command._pickMode).toBeUndefined();
    });

    it("reuses the supplied result object", function () {
      const command = makeCommand(true);
      const reused = { command: undefined };
      const result = WebGPUDerivedCommand.createLogDepthCommand(
        command,
        reused,
      );
      expect(result).toBe(reused);
      expect(reused.command._logDepth).toBe(true);
    });
  });

  describe("createPickDerivedCommand", function () {
    it("sets pick mode and stores the pick color array", function () {
      const command = makeCommand(true);
      const pickId = [0.1, 0.2, 0.3, 1.0];
      const result = WebGPUDerivedCommand.createPickDerivedCommand(
        command,
        pickId,
      );
      expect(result.command._pickMode).toBe(true);
      expect(result.command._pickColor).toBe(pickId);
    });

    it("clones the command without mutating the base", function () {
      const command = makeCommand(true);
      const result = WebGPUDerivedCommand.createPickDerivedCommand(
        command,
        [0, 0, 0, 1],
      );
      expect(result.command._cloned).toBe(true);
      expect(command._pickMode).toBeUndefined();
    });

    it("reuses the supplied result object", function () {
      const command = makeCommand(true);
      const reused = { command: undefined };
      const result = WebGPUDerivedCommand.createPickDerivedCommand(
        command,
        [1, 1, 1, 1],
        reused,
      );
      expect(result).toBe(reused);
      expect(reused.command._pickMode).toBe(true);
    });
  });

  describe("createHDRDerivedCommand", function () {
    it("sets HDR mode and the rgba16float color target format", function () {
      const command = makeCommand(true);
      const result = WebGPUDerivedCommand.createHDRDerivedCommand(command);
      expect(result.command._hdrMode).toBe(true);
      expect(result.command._colorTargetFormat).toBe("rgba16float");
    });

    it("reuses the supplied result object", function () {
      const command = makeCommand(true);
      const reused = { command: undefined };
      const result = WebGPUDerivedCommand.createHDRDerivedCommand(
        command,
        reused,
      );
      expect(result).toBe(reused);
      expect(reused.command._hdrMode).toBe(true);
    });
  });

  describe("createShadowDerivedCommand", function () {
    it("stamps the full shadow-casting override set", function () {
      const command = makeCommand(true);
      const result = WebGPUDerivedCommand.createShadowDerivedCommand(command);
      expect(result.command._shadowMode).toBe(true);
      expect(result.command._depthOnly).toBe(true);
      expect(result.command._colorWriteMask).toBe(0);
      expect(result.command._depthWriteEnabled).toBe(true);
      expect(result.command._cullMode).toBe("front");
      expect(result.command._depthBias).toBe(1);
      expect(result.command._depthBiasSlopeScale).toBe(1.0);
    });

    it("clones the command without mutating the base", function () {
      const command = makeCommand(true);
      const result = WebGPUDerivedCommand.createShadowDerivedCommand(command);
      expect(result.command._cloned).toBe(true);
      expect(command._shadowMode).toBeUndefined();
    });

    it("reuses the supplied result object", function () {
      const command = makeCommand(true);
      const reused = { command: undefined };
      const result = WebGPUDerivedCommand.createShadowDerivedCommand(
        command,
        reused,
      );
      expect(result).toBe(reused);
      expect(reused.command._shadowMode).toBe(true);
    });
  });

  describe("cache accounting (clearCache / getCacheStats)", function () {
    it("reports zeroed pipeline and shader counts on a cleared cache", function () {
      const stats = WebGPUDerivedCommand.getCacheStats();
      expect(stats.pipelines).toBe(0);
      expect(stats.shaders).toBe(0);
    });

    it("clearCache() is idempotent and leaves stats at zero", function () {
      WebGPUDerivedCommand.clearCache();
      WebGPUDerivedCommand.clearCache();
      const stats = WebGPUDerivedCommand.getCacheStats();
      expect(stats.pipelines).toBe(0);
      expect(stats.shaders).toBe(0);
    });

    it("derived-command creation does not populate the pipeline/shader caches", function () {
      // The factory methods stamp pipeline-descriptor state onto the
      // command but never build the GPU pipeline, so the caches stay
      // empty without a device.
      const command = makeCommand(true);
      WebGPUDerivedCommand.createDepthOnlyDerivedCommand(command);
      WebGPUDerivedCommand.createShadowDerivedCommand(command);
      const stats = WebGPUDerivedCommand.getCacheStats();
      expect(stats.pipelines).toBe(0);
      expect(stats.shaders).toBe(0);
    });
  });
});
