import ContextFactory from "../../../Source/Renderer/ContextFactory.js";
import createCanvas from "../../../../../Specs/createCanvas.js";

describe("Renderer/ContextFactory", function () {
  it("is defined", function () {
    expect(ContextFactory).toBeDefined();
  });

  it("reports WebGL support", function () {
    // WebGL should be supported in any modern browser running tests
    const supported = ContextFactory.isRendererSupported("webgl");
    expect(typeof supported).toBe("boolean");
  });

  it("reports WebGPU support status", function () {
    // May or may not be supported depending on browser
    const supported = ContextFactory.isRendererSupported("webgpu");
    expect(typeof supported).toBe("boolean");
  });

  it("provides renderer info", function () {
    const info = ContextFactory.getRendererInfo();
    expect(info).toBeDefined();
    expect(typeof info.webgl).toBe("boolean");
    expect(typeof info.webgpu).toBe("boolean");
    expect(info.recommended).toBeDefined();
  });

  it("creates a WebGL context", async function () {
    const canvas = createCanvas();
    try {
      const context = await ContextFactory.createContext(canvas, {
        renderer: "webgl",
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

  it("creates a WebGPU context when supported", async function () {
    if (!ContextFactory.isRendererSupported("webgpu")) {
      // Skip test when WebGPU is not available
      return;
    }

    const canvas = createCanvas();
    try {
      const context = await ContextFactory.createContext(canvas, {
        renderer: "webgpu",
      });
      expect(context).toBeDefined();
      expect(context.isWebGPU).toBe(true);
      expect(context.isWebGL).toBe(false);
      expect(context.id).toBeDefined();
      expect(context.rendererType).toBeDefined();
      context.destroy();
    } finally {
      document.body.removeChild(canvas);
    }
  });

  it("falls back to WebGL when WebGPU unavailable and auto mode", async function () {
    if (ContextFactory.isRendererSupported("webgpu")) {
      // Can't test fallback when WebGPU is available
      return;
    }

    const canvas = createCanvas();
    try {
      const context = await ContextFactory.createContext(canvas, {
        renderer: "auto",
      });
      expect(context).toBeDefined();
      expect(context.isWebGL).toBe(true);
      context.destroy();
    } finally {
      document.body.removeChild(canvas);
    }
  });
});
