import ContextFactory, {
  ContextCreationError,
  RendererInitializationError,
} from "../../../Source/Renderer/ContextFactory.js";
import RendererType, {
  getDefaultRendererType,
  getGlobalDefaultRenderer,
  getRendererAttemptPlan,
  getSynchronousRendererType,
  setGlobalDefaultRenderer,
} from "../../../Source/Renderer/RendererType.js";
import createCanvas from "../../../../../Specs/createCanvas.js";

describe("Renderer/ContextFactory", function () {
  function makeHooks(options = {}) {
    const calls = {
      support: 0,
      webgl: [],
      webgpu: [],
    };
    const webglContext = { name: "webgl-context" };
    const webgpuContext = { name: "webgpu-context" };
    const hooks = {
      buildCapabilities: options.buildCapabilities ?? {
        webgl: true,
        webgpu: true,
      },
      isWebGPUSupported() {
        calls.support += 1;
        return options.webgpuSupported !== false;
      },
      async createWebGL(_canvas, contextOptions) {
        calls.webgl.push(contextOptions);
        if (options.webglFailure) {
          throw options.webglFailure;
        }
        return webglContext;
      },
      async createWebGPU(_canvas, contextOptions) {
        calls.webgpu.push(contextOptions);
        if (options.webgpuFailure) {
          throw options.webgpuFailure;
        }
        return webgpuContext;
      },
    };
    return { hooks, calls, webglContext, webgpuContext };
  }

  async function captureRejection(promise) {
    try {
      await promise;
      fail("Expected promise to reject");
    } catch (error) {
      return error;
    }
  }

  it("is defined", function () {
    expect(ContextFactory).toBeDefined();
  });

  describe("attempt policy", function () {
    it("uses WebGPU then WebGL for omitted and AUTO requests", function () {
      const omitted = getRendererAttemptPlan();
      const auto = getRendererAttemptPlan({ renderer: RendererType.AUTO });

      expect(omitted.requestedRenderer).toBe(RendererType.AUTO);
      expect(omitted.attempts).toEqual([
        RendererType.WEBGPU,
        RendererType.WEBGL,
      ]);
      expect(omitted.selectionReason).toBe("auto-webgpu-first");
      expect(auto).toEqual(omitted);
      expect(Object.isFrozen(omitted.attempts)).toBe(true);
    });

    it("uses only WebGL when AUTO explicitly disables WebGPU preference", function () {
      const plan = getRendererAttemptPlan({
        renderer: RendererType.AUTO,
        preferWebGPU: false,
      });

      expect(plan.attempts).toEqual([RendererType.WEBGL]);
      expect(plan.selectionReason).toBe("auto-webgl-only");
    });

    it("falls explicit WebGPU requests back to WebGL by default", function () {
      expect(
        getRendererAttemptPlan({ renderer: RendererType.WEBGL }).attempts,
      ).toEqual([RendererType.WEBGL]);
      expect(
        getRendererAttemptPlan({
          renderer: RendererType.WEBGPU,
          preferWebGPU: false,
        }).attempts,
      ).toEqual([RendererType.WEBGPU, RendererType.WEBGL]);
      expect(
        getRendererAttemptPlan({ renderer: RendererType.WEBGPU_COMPAT })
          .attempts,
      ).toEqual([RendererType.WEBGPU_COMPAT, RendererType.WEBGL]);
    });

    it("keeps explicit renderer policies strict with the strictRenderer opt-in", function () {
      expect(
        getRendererAttemptPlan({
          renderer: RendererType.WEBGPU,
          strictRenderer: true,
        }).attempts,
      ).toEqual([RendererType.WEBGPU]);
      expect(
        getRendererAttemptPlan({
          renderer: RendererType.WEBGPU_COMPAT,
          strictRenderer: true,
        }).attempts,
      ).toEqual([RendererType.WEBGPU_COMPAT]);
      expect(
        getRendererAttemptPlan({
          renderer: RendererType.WEBGL,
          strictRenderer: true,
        }).attempts,
      ).toEqual([RendererType.WEBGL]);
    });

    it("keeps explicit WebGPU strict when the build has no WebGL fallback", function () {
      expect(
        getRendererAttemptPlan(
          { renderer: RendererType.WEBGPU },
          { webgl: false, webgpu: true },
        ).attempts,
      ).toEqual([RendererType.WEBGPU]);
    });

    it("throws for invalid renderer values instead of silently using AUTO", function () {
      expect(function () {
        getRendererAttemptPlan({ renderer: "not-a-renderer" });
      }).toThrowError('Invalid renderer type "not-a-renderer".');
      expect(function () {
        getRendererAttemptPlan({ renderer: 17 });
      }).toThrowError('Invalid renderer type "17".');
    });

    it("does not read the mutable legacy global default", function () {
      const previous = getGlobalDefaultRenderer();
      try {
        setGlobalDefaultRenderer(RendererType.WEBGL);
        expect(getRendererAttemptPlan().attempts).toEqual([
          RendererType.WEBGPU,
          RendererType.WEBGL,
        ]);
      } finally {
        setGlobalDefaultRenderer(previous);
      }
    });

    it("prunes unavailable backends from AUTO using immutable build capabilities", function () {
      const webglOnly = getRendererAttemptPlan(
        {},
        { webgl: true, webgpu: false },
      );
      const webgpuOnly = getRendererAttemptPlan(
        {},
        { webgl: false, webgpu: true },
      );

      expect(webglOnly.attempts).toEqual([RendererType.WEBGL]);
      expect(webglOnly.selectionReason).toBe("auto-build-webgl-only");
      expect(webgpuOnly.attempts).toEqual([RendererType.WEBGPU]);
      expect(webgpuOnly.selectionReason).toBe("auto-build-webgpu-only");
      const explicitWebGLPreference = getRendererAttemptPlan(
        { preferWebGPU: false },
        { webgl: false, webgpu: true },
      );
      expect(explicitWebGLPreference.attempts).toEqual([RendererType.WEBGL]);
      expect(explicitWebGLPreference.selectionReason).toBe("auto-webgl-only");
    });

    it("keeps legacy synchronous construction WebGL-only", function () {
      expect(getSynchronousRendererType()).toBe(RendererType.WEBGL);
      expect(getSynchronousRendererType({ renderer: RendererType.WEBGL })).toBe(
        RendererType.WEBGL,
      );

      for (const renderer of [
        RendererType.AUTO,
        RendererType.WEBGPU,
        RendererType.WEBGPU_COMPAT,
      ]) {
        expect(function () {
          getSynchronousRendererType({ renderer });
        }).toThrowError(
          `Renderer "${renderer}" requires asynchronous initialization. Use createAsync instead.`,
        );
      }
    });

    it("validates synchronous renderer values and build availability", function () {
      expect(function () {
        getSynchronousRendererType({ renderer: "not-a-renderer" });
      }).toThrowError('Invalid renderer type "not-a-renderer".');
      expect(function () {
        getSynchronousRendererType(
          { renderer: RendererType.WEBGL },
          { webgl: false, webgpu: true },
        );
      }).toThrowError("WebGL is not available in this build.");
    });
  });

  describe("policy execution", function () {
    it("resolves omitted AUTO to WebGPU without touching WebGL on success", async function () {
      const fixture = makeHooks();
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        undefined,
        fixture.hooks,
      );

      expect(result.context).toBe(fixture.webgpuContext);
      expect(fixture.calls.webgpu.length).toBe(1);
      expect(fixture.calls.webgl.length).toBe(0);
      expect(result.diagnostics).toEqual({
        requestedRenderer: RendererType.AUTO,
        resolvedRenderer: RendererType.WEBGPU,
        selectionReason: "auto-webgpu-first",
        attempts: [{ renderer: RendererType.WEBGPU, status: "succeeded" }],
        fallback: null,
      });
      expect(Object.isFrozen(result.diagnostics)).toBe(true);
      expect(Object.isFrozen(result.diagnostics.attempts)).toBe(true);
      expect(Object.isFrozen(result.diagnostics.attempts[0])).toBe(true);
    });

    for (const stage of ["adapter", "device", "context"]) {
      it(`falls AUTO back to WebGL after a ${stage} initialization failure`, async function () {
        const failure = new RendererInitializationError(
          stage,
          `${stage} failed`,
        );
        const fixture = makeHooks({ webgpuFailure: failure });
        const result = await ContextFactory.createContextWithDiagnostics(
          {},
          { renderer: RendererType.AUTO },
          fixture.hooks,
        );

        expect(result.context).toBe(fixture.webglContext);
        expect(fixture.calls.webgpu.length).toBe(1);
        expect(fixture.calls.webgl.length).toBe(1);
        expect(fixture.calls.webgl[0].renderer).toBe(RendererType.WEBGL);
        expect(result.diagnostics.resolvedRenderer).toBe(RendererType.WEBGL);
        expect(result.diagnostics.attempts).toEqual([
          {
            renderer: RendererType.WEBGPU,
            status: "failed",
            stage,
            message: `${stage} failed`,
          },
          { renderer: RendererType.WEBGL, status: "succeeded" },
        ]);
        expect(result.diagnostics.fallback).toEqual({
          fromRenderer: RendererType.WEBGPU,
          stage,
          message: `${stage} failed`,
        });
        expect(Object.isFrozen(result.diagnostics)).toBe(true);
        expect(Object.isFrozen(result.diagnostics.attempts)).toBe(true);
        expect(
          result.diagnostics.attempts.every((attempt) =>
            Object.isFrozen(attempt),
          ),
        ).toBe(true);
        expect(Object.isFrozen(result.diagnostics.fallback)).toBe(true);
      });
    }

    it("records API unavailability and falls AUTO back without invoking WebGPU creation", async function () {
      const fixture = makeHooks({ webgpuSupported: false });
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.AUTO },
        fixture.hooks,
      );

      expect(fixture.calls.webgpu.length).toBe(0);
      expect(fixture.calls.webgl.length).toBe(1);
      expect(result.diagnostics.fallback.stage).toBe("availability");
      expect(result.diagnostics.attempts[0].renderer).toBe(RendererType.WEBGPU);
    });

    it("uses WebGL only for AUTO with preferWebGPU false", async function () {
      const fixture = makeHooks();
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.AUTO, preferWebGPU: false },
        fixture.hooks,
      );

      expect(result.context).toBe(fixture.webglContext);
      expect(fixture.calls.support).toBe(0);
      expect(fixture.calls.webgpu.length).toBe(0);
      expect(fixture.calls.webgl.length).toBe(1);
      expect(result.diagnostics.selectionReason).toBe("auto-webgl-only");
      expect(result.diagnostics.fallback).toBeNull();
    });

    it("reports a structured availability failure when a WebGPU-only build explicitly prefers WebGL", async function () {
      const fixture = makeHooks({
        buildCapabilities: { webgl: false, webgpu: true },
      });
      const error = await captureRejection(
        ContextFactory.createContextWithDiagnostics(
          {},
          { renderer: RendererType.AUTO, preferWebGPU: false },
          fixture.hooks,
        ),
      );

      expect(error instanceof ContextCreationError).toBe(true);
      expect(fixture.calls.support).toBe(0);
      expect(fixture.calls.webgpu.length).toBe(0);
      expect(fixture.calls.webgl.length).toBe(0);
      expect(error.diagnostics.selectionReason).toBe("auto-webgl-only");
      expect(error.diagnostics.attempts).toEqual([
        {
          renderer: RendererType.WEBGL,
          status: "failed",
          stage: "availability",
          message: "webgl is not available in this build.",
        },
      ]);
    });

    it("falls explicit WebGPU back to WebGL with a console warning by default", async function () {
      const fixture = makeHooks({
        webgpuFailure: new RendererInitializationError(
          "device",
          "device failed",
        ),
      });
      spyOn(console, "warn");
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.WEBGPU },
        fixture.hooks,
      );

      expect(result.context).toBe(fixture.webglContext);
      expect(fixture.calls.webgpu.length).toBe(1);
      expect(fixture.calls.webgl.length).toBe(1);
      expect(result.diagnostics.requestedRenderer).toBe(RendererType.WEBGPU);
      expect(result.diagnostics.resolvedRenderer).toBe(RendererType.WEBGL);
      expect(result.diagnostics.selectionReason).toBe("explicit");
      expect(result.diagnostics.fallback).toEqual({
        fromRenderer: RendererType.WEBGPU,
        stage: "device",
        message: "device failed",
      });
      expect(console.warn).toHaveBeenCalledWith(
        jasmine.stringContaining('Explicitly requested renderer "webgpu"'),
      );
    });

    it("keeps explicit WebGPU strict on initialization failure with strictRenderer", async function () {
      const fixture = makeHooks({
        webgpuFailure: new RendererInitializationError(
          "device",
          "device failed",
        ),
      });
      const error = await captureRejection(
        ContextFactory.createContextWithDiagnostics(
          {},
          { renderer: RendererType.WEBGPU, strictRenderer: true },
          fixture.hooks,
        ),
      );

      expect(error instanceof ContextCreationError).toBe(true);
      expect(fixture.calls.webgl.length).toBe(0);
      expect(error.diagnostics.requestedRenderer).toBe(RendererType.WEBGPU);
      expect(error.diagnostics.resolvedRenderer).toBeNull();
      expect(error.diagnostics.fallback).toBeNull();
      expect(error.diagnostics.attempts[0].stage).toBe("device");
      expect(Object.isFrozen(error.diagnostics)).toBe(true);
      expect(Object.isFrozen(error.diagnostics.attempts)).toBe(true);
      expect(Object.isFrozen(error.diagnostics.attempts[0])).toBe(true);
    });

    it("creates explicit compatibility WebGPU with compatibility options", async function () {
      const fixture = makeHooks();
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.WEBGPU_COMPAT, featureLevel: "core" },
        fixture.hooks,
      );

      expect(result.context).toBe(fixture.webgpuContext);
      expect(fixture.calls.webgpu[0].renderer).toBe(RendererType.WEBGPU_COMPAT);
      expect(fixture.calls.webgpu[0].featureLevel).toBe("compatibility");
      expect(result.diagnostics.resolvedRenderer).toBe(
        RendererType.WEBGPU_COMPAT,
      );
    });

    it("short-circuits WebGPU entirely for AUTO in a WebGL-only build", async function () {
      const fixture = makeHooks({
        buildCapabilities: { webgl: true, webgpu: false },
      });
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.AUTO },
        fixture.hooks,
      );

      expect(result.context).toBe(fixture.webglContext);
      expect(fixture.calls.support).toBe(0);
      expect(fixture.calls.webgpu.length).toBe(0);
      expect(fixture.calls.webgl.length).toBe(1);
      expect(result.diagnostics.attempts).toEqual([
        { renderer: RendererType.WEBGL, status: "succeeded" },
      ]);
      expect(result.diagnostics.selectionReason).toBe("auto-build-webgl-only");
    });

    it("falls explicit WebGPU back to WebGL in a WebGL-only build by default", async function () {
      const fixture = makeHooks({
        buildCapabilities: { webgl: true, webgpu: false },
      });
      spyOn(console, "warn");
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.WEBGPU },
        fixture.hooks,
      );

      expect(fixture.calls.support).toBe(0);
      expect(fixture.calls.webgpu.length).toBe(0);
      expect(fixture.calls.webgl.length).toBe(1);
      expect(result.context).toBe(fixture.webglContext);
      expect(result.diagnostics.attempts[0].stage).toBe("availability");
      expect(result.diagnostics.attempts[0].message).toBe(
        "webgpu is not available in this build.",
      );
      expect(result.diagnostics.fallback).toEqual({
        fromRenderer: RendererType.WEBGPU,
        stage: "availability",
        message: "webgpu is not available in this build.",
      });
      expect(console.warn).toHaveBeenCalled();
    });

    it("fails explicit strict WebGPU before creation in a WebGL-only build", async function () {
      const fixture = makeHooks({
        buildCapabilities: { webgl: true, webgpu: false },
      });
      const error = await captureRejection(
        ContextFactory.createContextWithDiagnostics(
          {},
          { renderer: RendererType.WEBGPU, strictRenderer: true },
          fixture.hooks,
        ),
      );

      expect(fixture.calls.support).toBe(0);
      expect(fixture.calls.webgpu.length).toBe(0);
      expect(error.diagnostics.attempts[0].stage).toBe("availability");
      expect(error.diagnostics.attempts[0].message).toBe(
        "webgpu is not available in this build.",
      );
    });

    it("falls compatibility WebGPU back to WebGL", async function () {
      const fixture = makeHooks({
        webgpuFailure: new RendererInitializationError(
          "adapter",
          "compatibility adapter failed",
        ),
      });
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.WEBGPU_COMPAT },
        fixture.hooks,
      );

      expect(result.context).toBe(fixture.webglContext);
      expect(result.diagnostics.fallback).toEqual({
        fromRenderer: RendererType.WEBGPU_COMPAT,
        stage: "adapter",
        message: "compatibility adapter failed",
      });
    });

    it("falls compatibility mode directly to WebGL in a WebGL-only build", async function () {
      const fixture = makeHooks({
        buildCapabilities: { webgl: true, webgpu: false },
      });
      const result = await ContextFactory.createContextWithDiagnostics(
        {},
        { renderer: RendererType.WEBGPU_COMPAT },
        fixture.hooks,
      );

      expect(fixture.calls.support).toBe(0);
      expect(fixture.calls.webgpu.length).toBe(0);
      expect(fixture.calls.webgl.length).toBe(1);
      expect(result.diagnostics.fallback).toEqual({
        fromRenderer: RendererType.WEBGPU_COMPAT,
        stage: "availability",
        message: "webgpu-compat is not available in this build.",
      });
    });

    it("reports both failures when AUTO cannot create either backend", async function () {
      const fixture = makeHooks({
        webgpuFailure: new RendererInitializationError(
          "context",
          "webgpu context failed",
        ),
        webglFailure: new Error("webgl context failed"),
      });
      const error = await captureRejection(
        ContextFactory.createContextWithDiagnostics(
          {},
          { renderer: RendererType.AUTO },
          fixture.hooks,
        ),
      );

      expect(error instanceof ContextCreationError).toBe(true);
      expect(error.diagnostics.attempts.length).toBe(2);
      expect(error.diagnostics.attempts[1]).toEqual({
        renderer: RendererType.WEBGL,
        status: "failed",
        stage: "unknown",
        message: "webgl context failed",
      });
      expect(error.diagnostics.fallback.fromRenderer).toBe(RendererType.WEBGPU);
    });
  });

  describe("environment reporting", function () {
    it("reports renderer support", function () {
      expect(typeof ContextFactory.isRendererSupported("webgl")).toBe(
        "boolean",
      );
      expect(typeof ContextFactory.isRendererSupported("webgpu")).toBe(
        "boolean",
      );
      expect(ContextFactory.isRendererSupported("not-a-renderer")).toBe(false);
    });

    it("provides renderer info", function () {
      const info = ContextFactory.getRendererInfo();
      expect(info).toBeDefined();
      expect(typeof info.webgl).toBe("boolean");
      expect(typeof info.webgpu).toBe("boolean");
      expect(info.recommended).toBeDefined();
    });

    it("never reports or recommends a backend stripped from the build", function () {
      const webglOnly = { webgl: true, webgpu: false };
      const webgpuOnly = { webgl: false, webgpu: true };

      expect(
        ContextFactory.isRendererSupported(RendererType.WEBGPU, webglOnly),
      ).toBe(false);
      expect(
        ContextFactory.isRendererSupported(
          RendererType.WEBGPU_COMPAT,
          webglOnly,
        ),
      ).toBe(false);
      expect(getDefaultRendererType(true, webglOnly)).toBe(RendererType.WEBGL);

      const webglInfo = ContextFactory.getRendererInfo(webglOnly);
      expect(webglInfo.webgpu).toBe(false);
      expect(webglInfo.webgpuCompat).toBe(false);
      expect(webglInfo.recommended).toBe(RendererType.WEBGL);

      expect(
        ContextFactory.isRendererSupported(RendererType.WEBGL, webgpuOnly),
      ).toBe(false);
      expect(getDefaultRendererType(false, webgpuOnly)).toBe(
        RendererType.WEBGPU,
      );
      expect(ContextFactory.getRendererInfo(webgpuOnly).recommended).toBe(
        RendererType.WEBGPU,
      );
      expect(
        ContextFactory.isRendererSupported(RendererType.AUTO, {
          webgl: false,
          webgpu: false,
        }),
      ).toBe(false);
    });
  });

  it("creates a real WebGL context through the default hooks", async function () {
    const canvas = createCanvas();
    try {
      const context = await ContextFactory.createContext(canvas, {
        renderer: RendererType.WEBGL,
      });
      expect(context).toBeDefined();
      expect(context.isWebGL).toBe(true);
      expect(context.isWebGPU).toBe(false);
      expect(context.id).toBeDefined();
      context.destroy();
    } finally {
      document.body.removeChild(canvas);
    }
  });
});
