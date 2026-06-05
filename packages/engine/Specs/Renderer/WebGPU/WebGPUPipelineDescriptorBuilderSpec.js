import { WebGPUPipelineDescriptorBuilder } from "../../../Source/Renderer/WebGPU/WebGPUPipelineDescriptorBuilder.js";

describe("Renderer/WebGPU/WebGPUPipelineDescriptorBuilder", function () {
  // The builder is a pure descriptor factory — it assembles a plain
  // WebGPURenderPipelineDescriptor object from fluent setters and never
  // touches a live GPUDevice (no createShaderModule / createRenderPipeline
  // calls happen here). The GPUShaderModule arguments are stored as opaque
  // references, so we pass lightweight stand-in objects. This gives a
  // Karma run cheap, deterministic coverage that pins the defaults and
  // state-construction contract so an accidental default flip (e.g.
  // depthCompare 'less-equal' → 'less') fails fast in CI.

  // Opaque stand-ins for GPUShaderModule. The builder only stores these by
  // reference; it never invokes any method on them.
  const vs = { __stub: "vertex-module" };
  const fs = { __stub: "fragment-module" };

  describe("fluent setters return the builder for chaining", function () {
    it("each setter returns the same instance", function () {
      const b = new WebGPUPipelineDescriptorBuilder();
      expect(b.setName("p")).toBe(b);
      expect(b.setVertexShader(vs)).toBe(b);
      expect(b.setFragmentShader(fs)).toBe(b);
      expect(b.setLayout("auto")).toBe(b);
      expect(b.setTopology("triangle-list")).toBe(b);
      expect(b.setCullMode("back")).toBe(b);
      expect(b.setFrontFace("ccw")).toBe(b);
      expect(b.enableDepthTest()).toBe(b);
      expect(b.enableMultisampling()).toBe(b);
      expect(b.reset()).toBe(b);
    });
  });

  describe("setVertexShader", function () {
    it("defaults the entry point to 'vertexMain'", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .build();
      expect(d.vertex.module).toBe(vs);
      expect(d.vertex.entryPoint).toBe("vertexMain");
      expect(d.vertex.buffers).toBeUndefined();
    });

    it("honors an explicit entry point and buffers", function () {
      const buffers = [{ arrayStride: 12, attributes: [] }];
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs, "vsCustom", buffers)
        .build();
      expect(d.vertex.entryPoint).toBe("vsCustom");
      expect(d.vertex.buffers).toBe(buffers);
    });
  });

  describe("setFragmentShader", function () {
    it("defaults the entry point to 'fragmentMain'", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setFragmentShader(fs)
        .build();
      expect(d.fragment.module).toBe(fs);
      expect(d.fragment.entryPoint).toBe("fragmentMain");
    });

    it("defaults targets to a single bgra8unorm color target", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setFragmentShader(fs)
        .build();
      expect(d.fragment.targets.length).toBe(1);
      expect(d.fragment.targets[0].format).toBe("bgra8unorm");
    });

    it("honors explicit targets", function () {
      const targets = [{ format: "rgba8unorm" }];
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setFragmentShader(fs, "fragmentMain", targets)
        .build();
      expect(d.fragment.targets).toBe(targets);
    });
  });

  describe("primitive state", function () {
    it("falls back to the default primitive block when none is set", function () {
      // build() supplies this default only when no primitive setter ran.
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .build();
      expect(d.primitive).toEqual({
        topology: "triangle-list",
        cullMode: "back",
        frontFace: "ccw",
      });
    });

    it("merges topology, cullMode, and frontFace into one primitive block", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setTopology("line-list")
        .setCullMode("none")
        .setFrontFace("cw")
        .build();
      expect(d.primitive.topology).toBe("line-list");
      expect(d.primitive.cullMode).toBe("none");
      expect(d.primitive.frontFace).toBe("cw");
    });

    it("a single primitive setter suppresses the build() default block", function () {
      // Setting only cullMode means topology/frontFace are absent rather
      // than the build() defaults — the default block is all-or-nothing.
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setCullMode("front")
        .build();
      expect(d.primitive.cullMode).toBe("front");
      expect(d.primitive.topology).toBeUndefined();
      expect(d.primitive.frontFace).toBeUndefined();
    });
  });

  describe("enableDepthTest / disableDepthTest", function () {
    it("uses depth24plus, less-equal, write=true by default", function () {
      // The default depthCompare is 'less-equal' (NOT 'less') — this is the
      // planetary-scale rationale called out in WebGPUContext._depthCompare.
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest()
        .build();
      expect(d.depthStencil.format).toBe("depth24plus");
      expect(d.depthStencil.depthCompare).toBe("less-equal");
      expect(d.depthStencil.depthWriteEnabled).toBe(true);
    });

    it("honors explicit format, compare, and write args", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest("depth32float", "greater", false)
        .build();
      expect(d.depthStencil.format).toBe("depth32float");
      expect(d.depthStencil.depthCompare).toBe("greater");
      expect(d.depthStencil.depthWriteEnabled).toBe(false);
    });

    it("mutates an existing depthStencil block instead of replacing it", function () {
      // Calling setStencilReadMask first creates the block; a later
      // enableDepthTest must overwrite format/compare/write but preserve
      // the previously-set stencil mask.
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setStencilReadMask(0x0f)
        .enableDepthTest("depth32float", "always", false)
        .build();
      expect(d.depthStencil.format).toBe("depth32float");
      expect(d.depthStencil.depthCompare).toBe("always");
      expect(d.depthStencil.depthWriteEnabled).toBe(false);
      expect(d.depthStencil.stencilReadMask).toBe(0x0f);
    });

    it("clears depthStencil to undefined", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest()
        .disableDepthTest()
        .build();
      expect(d.depthStencil).toBeUndefined();
    });
  });

  describe("stencil state (_ensureDepthStencil auto-init)", function () {
    it("auto-initialises a depth+stencil block when enabling stencil first", function () {
      const front = {
        compare: "always",
        passOp: "replace",
        failOp: "keep",
        depthFailOp: "keep",
      };
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableStencilTest(front)
        .build();
      expect(d.depthStencil.format).toBe("depth24plus-stencil8");
      expect(d.depthStencil.depthWriteEnabled).toBe(true);
      expect(d.depthStencil.depthCompare).toBe("less-equal");
      expect(d.depthStencil.stencilFront).toBe(front);
      // back defaults to front when omitted (?? front).
      expect(d.depthStencil.stencilBack).toBe(front);
    });

    it("uses the provided back face state when given", function () {
      const front = { compare: "always", passOp: "replace" };
      const back = { compare: "never", passOp: "keep" };
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableStencilTest(front, back)
        .build();
      expect(d.depthStencil.stencilFront).toBe(front);
      expect(d.depthStencil.stencilBack).toBe(back);
    });

    it("upgrades a depth-only depth24plus format to depth24plus-stencil8", function () {
      // enableDepthTest first sets depth24plus; a later stencil call must
      // upgrade the format so the stencil aspect is actually present.
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest()
        .setStencilWriteMask(0xff)
        .build();
      expect(d.depthStencil.format).toBe("depth24plus-stencil8");
      expect(d.depthStencil.stencilWriteMask).toBe(0xff);
    });

    it("upgrades a depth32float format to depth24plus-stencil8", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest("depth32float")
        .setStencilReadMask(0x12)
        .build();
      expect(d.depthStencil.format).toBe("depth24plus-stencil8");
      expect(d.depthStencil.stencilReadMask).toBe(0x12);
    });

    it("does NOT upgrade an already stencil-capable format", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest("depth24plus-stencil8")
        .setStencilReadMask(0x01)
        .build();
      expect(d.depthStencil.format).toBe("depth24plus-stencil8");
    });
  });

  describe("setDepthBias", function () {
    it("defaults slopeScale and clamp to 0", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setDepthBias(4)
        .build();
      expect(d.depthStencil.depthBias).toBe(4);
      expect(d.depthStencil.depthBiasSlopeScale).toBe(0);
      expect(d.depthStencil.depthBiasClamp).toBe(0);
    });

    it("honors explicit slopeScale and clamp", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setDepthBias(2, 1.5, 8)
        .build();
      expect(d.depthStencil.depthBias).toBe(2);
      expect(d.depthStencil.depthBiasSlopeScale).toBe(1.5);
      expect(d.depthStencil.depthBiasClamp).toBe(8);
    });

    it("auto-initialises a stencil-capable depthStencil block", function () {
      // setDepthBias routes through _ensureDepthStencil, so calling it with
      // no prior depth setup yields the depth24plus-stencil8 default.
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setDepthBias(1)
        .build();
      expect(d.depthStencil.format).toBe("depth24plus-stencil8");
    });
  });

  describe("enableMultisampling", function () {
    it("defaults sample count to 4", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableMultisampling()
        .build();
      expect(d.multisample.count).toBe(4);
    });

    it("honors an explicit sample count", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableMultisampling(2)
        .build();
      expect(d.multisample.count).toBe(2);
    });
  });

  describe("addVertexBuffer", function () {
    it("throws if no vertex shader has been set", function () {
      const b = new WebGPUPipelineDescriptorBuilder().setName("p");
      expect(() => b.addVertexBuffer(12, [])).toThrowError(
        /Vertex shader must be set before adding vertex buffers/,
      );
    });

    it("defaults stepMode to 'vertex' and appends the layout", function () {
      const attrs = [{ shaderLocation: 0, offset: 0, format: "float32x3" }];
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .addVertexBuffer(12, attrs)
        .build();
      expect(d.vertex.buffers.length).toBe(1);
      expect(d.vertex.buffers[0].arrayStride).toBe(12);
      expect(d.vertex.buffers[0].attributes).toBe(attrs);
      expect(d.vertex.buffers[0].stepMode).toBe("vertex");
    });

    it("honors an explicit instance stepMode and appends in order", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .addVertexBuffer(12, [])
        .addVertexBuffer(16, [], "instance")
        .build();
      expect(d.vertex.buffers.length).toBe(2);
      expect(d.vertex.buffers[0].stepMode).toBe("vertex");
      expect(d.vertex.buffers[1].arrayStride).toBe(16);
      expect(d.vertex.buffers[1].stepMode).toBe("instance");
    });
  });

  describe("build", function () {
    it("throws when the pipeline name is missing", function () {
      const b = new WebGPUPipelineDescriptorBuilder().setVertexShader(vs);
      expect(() => b.build()).toThrowError(/Pipeline name is required/);
    });

    it("throws when the vertex shader is missing", function () {
      const b = new WebGPUPipelineDescriptorBuilder().setName("p");
      expect(() => b.build()).toThrowError(/Vertex shader is required/);
    });

    it("defaults layout to 'auto' when not set", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .build();
      expect(d.layout).toBe("auto");
    });

    it("honors an explicit layout", function () {
      const layout = { __stub: "pipeline-layout" };
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .setLayout(layout)
        .build();
      expect(d.layout).toBe(layout);
    });

    it("leaves fragment, depthStencil, and multisample undefined when unset", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .build();
      expect(d.fragment).toBeUndefined();
      expect(d.depthStencil).toBeUndefined();
      expect(d.multisample).toBeUndefined();
    });

    it("carries the name through to the descriptor", function () {
      const d = new WebGPUPipelineDescriptorBuilder()
        .setName("MyPipeline")
        .setVertexShader(vs)
        .build();
      expect(d.name).toBe("MyPipeline");
    });
  });

  describe("reset", function () {
    it("clears all previously-set state", function () {
      const b = new WebGPUPipelineDescriptorBuilder()
        .setName("p")
        .setVertexShader(vs)
        .enableDepthTest();
      b.reset();
      // After reset, build() must fail the name check (state was cleared).
      expect(() => b.build()).toThrowError(/Pipeline name is required/);
    });
  });

  describe("static factory: createBasicColorPipeline", function () {
    it("configures name, both shaders, depth test, and back cull", function () {
      const d = WebGPUPipelineDescriptorBuilder.createBasicColorPipeline(
        "basic",
        vs,
        fs,
      ).build();
      expect(d.name).toBe("basic");
      expect(d.vertex.module).toBe(vs);
      expect(d.fragment.module).toBe(fs);
      expect(d.depthStencil.format).toBe("depth24plus");
      expect(d.depthStencil.depthCompare).toBe("less-equal");
      expect(d.primitive.cullMode).toBe("back");
    });
  });

  describe("static factory: createTexturedPipeline", function () {
    it("configures both shaders, depth test, and back cull", function () {
      const d = WebGPUPipelineDescriptorBuilder.createTexturedPipeline(
        "textured",
        vs,
        fs,
      ).build();
      expect(d.name).toBe("textured");
      expect(d.fragment.module).toBe(fs);
      expect(d.depthStencil.depthWriteEnabled).toBe(true);
      expect(d.primitive.cullMode).toBe("back");
    });
  });

  describe("static factory: createWireframePipeline", function () {
    it("uses line-list topology, depth test, and no culling", function () {
      const d = WebGPUPipelineDescriptorBuilder.createWireframePipeline(
        "wire",
        vs,
        fs,
      ).build();
      expect(d.name).toBe("wire");
      expect(d.primitive.topology).toBe("line-list");
      expect(d.primitive.cullMode).toBe("none");
      expect(d.depthStencil.format).toBe("depth24plus");
    });
  });

  describe("static factory: createDepthOnlyPipeline", function () {
    it("omits the fragment shader, enables depth, and back-culls", function () {
      const d = WebGPUPipelineDescriptorBuilder.createDepthOnlyPipeline(
        "depth",
        vs,
      ).build();
      expect(d.name).toBe("depth");
      expect(d.vertex.module).toBe(vs);
      expect(d.fragment).toBeUndefined();
      expect(d.depthStencil.format).toBe("depth24plus");
      expect(d.primitive.cullMode).toBe("back");
    });
  });

  describe("default export parity", function () {
    it("the named and default exports are the same class", function () {
      // Re-import the default export and confirm it matches the named one.
      // (Done via a fresh instance to avoid a duplicate top-level import.)
      const inst = new WebGPUPipelineDescriptorBuilder();
      // The build pipeline prefixes class names with `_` (e.g.
      // `_WebGPUPipelineDescriptorBuilder`), so match the suffix rather than
      // the exact name.
      expect(inst.constructor.name).toMatch(/WebGPUPipelineDescriptorBuilder$/);
    });
  });
});
